// Estado do checkout do comprador: catálogo, sessão, passos e sincronização.
//
// Duas regras estruturam este arquivo:
//
// 1. A SESSÃO NASCE NA PRIMEIRA VISITA e cada passo concluído é um PATCH. É isso
//    que alimenta o relatório de abandono por etapa — sem o PATCH por passo, o
//    painel saberia que houve abandono, mas não onde.
// 2. O VALOR É DO SERVIDOR. A estimativa local só preenche o intervalo entre o
//    clique e a resposta; quando o PATCH volta, o `amountCents` dele é o que fica.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { isApiError } from '../lib/api';
import {
  estimateMonthlyCents,
  fetchPlanCatalog,
  maxScreensOf,
  type Plan,
  type PlanCatalog,
} from '../lib/plans';
import {
  createSession,
  getSession,
  readAttribution,
  readSelectionHint,
  replaceUrlWithToken,
  submitSession,
  updateSession,
  type CheckoutPaymentResult,
  type CheckoutSession,
  type UpdateSessionInput,
} from '../lib/session';
import { localPhoneDigits, maskCnpj, maskCpf, maskPhone, onlyDigits } from './format';
import {
  emptyIdentity,
  IDENTITY_FIELD_ORDER,
  validateIdentity,
  validateIdentityField,
  type DocumentKind,
  type IdentityDraft,
  type IdentityErrors,
  type IdentityField,
} from './validation';

export type StepId = 'identify' | 'plan' | 'payment';

export const STEP_ORDER: StepId[] = ['identify', 'plan', 'payment'];

/** Debounce da mudança de telas: sem isso, cada clique no `+` seria um PATCH. */
const SCREENS_DEBOUNCE_MS = 600;

export interface FocusRequest {
  field: IdentityField;
  nonce: number;
}

const messageOf = (error: unknown, fallback: string): string => {
  if (isApiError(error)) return error.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

export function useCheckout(routeToken?: string) {
  // ─── Catálogo ──────────────────────────────────────────────────────────────
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);

  // ─── Sessão ────────────────────────────────────────────────────────────────
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [forceCreate, setForceCreate] = useState(false);
  const [expired, setExpired] = useState(false);
  const tokenRef = useRef<string | null>(null);

  // ─── Seleção ───────────────────────────────────────────────────────────────
  const [planCode, setPlanCode] = useState<string | null>(null);
  const [screens, setScreens] = useState(1);
  const [planError, setPlanError] = useState<string | null>(null);
  const [amountSyncing, setAmountSyncing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);

  // ─── Identificação ─────────────────────────────────────────────────────────
  const [identity, setIdentity] = useState<IdentityDraft>(emptyIdentity);
  const [identityErrors, setIdentityErrors] = useState<IdentityErrors>({});
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  // ─── Passos ────────────────────────────────────────────────────────────────
  const [activeStep, setActiveStep] = useState<StepId>('identify');
  const [completed, setCompleted] = useState<Record<StepId, boolean>>({
    identify: false,
    plan: false,
    payment: false,
  });
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CheckoutPaymentResult | null>(null);

  const plans = useMemo(() => catalog?.plans ?? [], [catalog]);
  const selectedPlan = useMemo<Plan | null>(
    () => plans.find((plan) => plan.code === planCode) ?? null,
    [plans, planCode]
  );

  // ─── Carga do catálogo ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setCatalogError(null);

    fetchPlanCatalog()
      .then((loaded) => {
        if (!cancelled) setCatalog(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCatalogError(
          messageOf(error, 'Não foi possível carregar os planos. Verifique sua conexão.')
        );
      });

    return () => {
      cancelled = true;
    };
  }, [catalogAttempt]);

  // ─── Abertura/criação da sessão ────────────────────────────────────────────
  const bootKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const effectiveToken = forceCreate ? null : (routeToken ?? null);
    const bootKey = `${effectiveToken ?? '(nova)'}#${sessionAttempt}`;
    // StrictMode roda o efeito duas vezes em desenvolvimento; sem esta guarda,
    // uma visita criaria DUAS sessões e duplicaria o lead no relatório.
    if (bootKeyRef.current === bootKey) return;
    bootKeyRef.current = bootKey;

    setSessionError(null);

    // A atribuição precisa ser lida antes de a URL ser reescrita com o token.
    const attribution = readAttribution();

    // Resultado obsoleto é descartado comparando a chave de boot, e NÃO por um
    // flag de cancelamento no cleanup. Motivo concreto: no StrictMode o efeito
    // roda, é limpo e roda de novo; um flag `cancelled` mataria a requisição da
    // primeira execução, enquanto a segunda seria bloqueada pela guarda de
    // deduplicação acima — e o checkout ficava preso em "carregando" para
    // sempre. Comparar a chave preserva as duas garantias: uma sessão por
    // visita, e nenhuma resposta antiga sobrescrevendo uma nova.
    const boot = async (myKey: string) => {
      const isStale = () => bootKeyRef.current !== myKey;

      try {
        const loaded = effectiveToken
          ? await getSession(effectiveToken)
          : await createSession(attribution);

        if (isStale()) return;
        tokenRef.current = loaded.publicToken;
        if (!effectiveToken) replaceUrlWithToken(loaded.publicToken);
        if (loaded.status === 'expired') setExpired(true);
        setSession(loaded);
      } catch (error) {
        if (isStale()) return;
        if (isApiError(error) && error.status === 410) {
          setExpired(true);
          return;
        }
        if (isApiError(error) && error.status === 404) {
          setSessionError('Este link de checkout não existe mais.');
          return;
        }
        setSessionError(
          messageOf(error, 'Não foi possível abrir o checkout. Verifique sua conexão.')
        );
      }
    };

    void boot(bootKey);
  }, [routeToken, sessionAttempt, forceCreate]);

  // ─── Hidratação (link de recuperação reabre onde a pessoa parou) ────────────
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!session || hydratedRef.current) return;
    hydratedRef.current = true;

    // Mescla em vez de sobrescrever: se a pessoa já digitou algo nesta visita,
    // o que veio do servidor não apaga o que está na tela.
    setIdentity((current) => {
      const digits = onlyDigits(session.document ?? '');
      const kind: DocumentKind = digits.length === 14 ? 'cnpj' : current.documentKind;
      return {
        name: session.name ?? current.name,
        email: session.email ?? current.email,
        phone: session.phone ? maskPhone(localPhoneDigits(session.phone)) : current.phone,
        documentKind: kind,
        document: digits
          ? kind === 'cnpj'
            ? maskCnpj(digits)
            : maskCpf(digits)
          : current.document,
        companyName: session.companyName ?? current.companyName,
      };
    });

    const identified = !!(session.name && session.email);
    const hasPlan = !!session.planCode;
    setCompleted({
      identify: identified,
      plan: identified && hasPlan,
      payment: !!session.paymentAt,
    });
    setActiveStep(identified ? (hasPlan ? 'payment' : 'plan') : 'identify');
  }, [session]);

  // ─── Sincronização com o servidor ──────────────────────────────────────────
  const pendingRef = useRef<UpdateSessionInput>({});
  const timerRef = useRef<number | null>(null);

  /** `true` quando o erro já foi tratado como estado de tela (não é falha de rede). */
  const handleFatal = useCallback((error: unknown): boolean => {
    if (!isApiError(error)) return false;
    if (error.status === 410 || error.code === 'session_expired') {
      setExpired(true);
      return true;
    }
    if (error.status === 409 || error.code === 'session_already_paid') {
      setSession((current) => (current ? { ...current, status: 'paid' } : current));
      return true;
    }
    return false;
  }, []);

  const sendPatch = useCallback(
    async (extra: UpdateSessionInput = {}): Promise<boolean> => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      const payload: UpdateSessionInput = { ...pendingRef.current, ...extra };
      pendingRef.current = {};

      const token = tokenRef.current;
      if (!token || Object.keys(payload).length === 0) {
        setAmountSyncing(false);
        return true;
      }

      setAmountSyncing(true);
      try {
        const next = await updateSession(token, payload);
        setSession(next);
        setSyncFailed(false);
        return true;
      } catch (error) {
        if (handleFatal(error)) return false;
        setSyncFailed(true);
        toast.error(messageOf(error, 'Não conseguimos salvar agora. Verifique sua conexão.'));
        return false;
      } finally {
        setAmountSyncing(false);
      }
    },
    [handleFatal]
  );

  const queuePatch = useCallback(
    (payload: UpdateSessionInput, delay: number) => {
      pendingRef.current = { ...pendingRef.current, ...payload };
      setAmountSyncing(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void sendPatch();
      }, delay);
    },
    [sendPatch]
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  // ─── Pré-seleção vinda do link (?plan=rede&screens=8) ──────────────────────
  const selectionHydratedRef = useRef(false);

  useEffect(() => {
    if (!catalog || !session || selectionHydratedRef.current) return;
    selectionHydratedRef.current = true;

    const known = (code: string | null): string | null =>
      code && catalog.plans.some((plan) => plan.code === code) ? code : null;

    const hint = readSelectionHint();
    const fromSession = known(session.planCode);
    const fromLink = fromSession ? null : known(hint.planCode);
    const code = fromSession ?? fromLink;

    const plan = catalog.plans.find((candidate) => candidate.code === code) ?? null;
    const wanted = session.screens > 1 ? session.screens : (hint.screens ?? session.screens);
    const clamped = Math.min(Math.max(1, wanted), maxScreensOf(plan));

    if (code) setPlanCode(code);
    setScreens(clamped);

    // Só registra no servidor o que ele ainda não sabe — o plano/telas vindos do
    // próprio servidor não geram PATCH redundante.
    const patch: UpdateSessionInput = {};
    if (fromLink) patch.planCode = fromLink;
    if (clamped !== session.screens) patch.screens = clamped;
    if (Object.keys(patch).length > 0) queuePatch(patch, 0);
  }, [catalog, session, queuePatch]);

  // ─── Ações de seleção ──────────────────────────────────────────────────────
  const choosePlan = useCallback(
    (code: string) => {
      setPlanError(null);
      setPlanCode(code);
      const plan = plans.find((candidate) => candidate.code === code) ?? null;
      const clamped = Math.min(screens, maxScreensOf(plan));
      if (clamped !== screens) setScreens(clamped);
      // Escolher plano é um clique deliberado: vai sem debounce.
      queuePatch({ planCode: code, screens: clamped }, 0);
    },
    [plans, screens, queuePatch]
  );

  const changeScreens = useCallback(
    (value: number) => {
      const max = maxScreensOf(selectedPlan);
      const next = Math.min(Math.max(1, Math.floor(value) || 1), max);
      setScreens(next);
      queuePatch({ screens: next }, SCREENS_DEBOUNCE_MS);
    },
    [selectedPlan, queuePatch]
  );

  const retrySync = useCallback(() => {
    const payload: UpdateSessionInput = { screens };
    if (planCode) payload.planCode = planCode;
    void sendPatch(payload);
  }, [planCode, screens, sendPatch]);

  // ─── Ações de identificação ────────────────────────────────────────────────
  const setIdentityField = useCallback((field: IdentityField, value: string) => {
    setIdentity((current) => {
      if (field === 'phone') return { ...current, phone: maskPhone(value) };
      if (field === 'document') {
        return {
          ...current,
          document: current.documentKind === 'cnpj' ? maskCnpj(value) : maskCpf(value),
        };
      }
      return { ...current, [field]: value };
    });
    // Erro sai da tela ao corrigir; a revalidação acontece no blur/avançar.
    setIdentityErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }, []);

  const setDocumentKind = useCallback((kind: DocumentKind) => {
    setIdentity((current) =>
      current.documentKind === kind
        ? current
        : { ...current, documentKind: kind, document: '', companyName: '' }
    );
    setIdentityErrors((current) => ({ ...current, document: undefined, companyName: undefined }));
  }, []);

  const blurIdentityField = useCallback(
    (field: IdentityField) => {
      setIdentityErrors((current) => ({
        ...current,
        [field]: validateIdentityField(field, identity),
      }));
    },
    [identity]
  );

  const submitIdentify = useCallback(async () => {
    const errors = validateIdentity(identity);
    setIdentityErrors(errors);

    const firstInvalid = IDENTITY_FIELD_ORDER.find((field) => errors[field]);
    if (firstInvalid) {
      setFocusRequest({ field: firstInvalid, nonce: Date.now() });
      return;
    }

    const digits = onlyDigits(identity.document);
    const payload: UpdateSessionInput = {
      name: identity.name.trim(),
      email: identity.email.trim(),
      // `55` explícito: o campo mostra `+55` fixo, então o registro guarda o
      // número completo e não fica ambíguo no painel.
      phone: `55${onlyDigits(identity.phone)}`,
      document: digits,
    };
    if (identity.documentKind === 'cnpj') payload.companyName = identity.companyName.trim();

    setSavingIdentity(true);
    const ok = await sendPatch(payload);
    setSavingIdentity(false);
    if (!ok) return;

    setCompleted((current) => ({ ...current, identify: true }));
    setActiveStep('plan');
  }, [identity, sendPatch]);

  const confirmPlan = useCallback(async () => {
    if (!planCode) {
      setPlanError('Escolha um plano para continuar.');
      return;
    }

    setSavingPlan(true);
    const ok = await sendPatch({ planCode, screens });
    setSavingPlan(false);
    if (!ok) return;

    setCompleted((current) => ({ ...current, plan: true }));
    setActiveStep('payment');
  }, [planCode, screens, sendPatch]);

  const finish = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;

    // Garante que a última mudança de telas em debounce já esteja gravada antes
    // de finalizar — o valor da contratação não pode ficar de fora por 600ms.
    const flushed = await sendPatch();
    if (!flushed) return;

    setSubmitting(true);
    try {
      const outcome = await submitSession(token);
      setSession(outcome.session);
      setResult(outcome.payment);
      setCompleted((current) => ({ ...current, payment: true }));
    } catch (error) {
      if (!handleFatal(error)) {
        toast.error(messageOf(error, 'Não conseguimos concluir agora. Tente novamente.'));
      }
    } finally {
      setSubmitting(false);
    }
  }, [handleFatal, sendPatch]);

  // ─── Navegação entre passos ────────────────────────────────────────────────
  const editStep = useCallback((step: StepId) => {
    setActiveStep(step);
  }, []);

  const stepState = useCallback(
    (step: StepId): 'active' | 'done' | 'pending' => {
      if (step === activeStep) return 'active';
      if (completed[step]) return 'done';
      return 'pending';
    },
    [activeStep, completed]
  );

  /** Recomeça do zero (link vencido): nova sessão, mantendo o que já foi digitado. */
  const startOver = useCallback(() => {
    hydratedRef.current = true; // preserva o que a pessoa já digitou nesta visita
    selectionHydratedRef.current = false;
    pendingRef.current = {};
    tokenRef.current = null;
    setExpired(false);
    setSessionError(null);
    setResult(null);
    setSession(null);
    setCompleted({ identify: false, plan: false, payment: false });
    setActiveStep('identify');
    setForceCreate(true);
    setSessionAttempt((attempt) => attempt + 1);
  }, []);

  const retryCatalog = useCallback(() => setCatalogAttempt((attempt) => attempt + 1), []);
  const retrySession = useCallback(() => setSessionAttempt((attempt) => attempt + 1), []);

  // ─── Valores ───────────────────────────────────────────────────────────────
  const localCents = estimateMonthlyCents(selectedPlan, screens);
  const serverCents = session?.amountCents ?? 0;
  /** Durante a ida ao servidor mostra a previsão; depois, o valor dele. */
  const totalCents = amountSyncing ? localCents : serverCents;

  return {
    // dados
    catalog,
    plans,
    policy: catalog?.billingPolicy ?? null,
    session,
    selectedPlan,
    planCode,
    screens,
    identity,
    identityErrors,
    focusRequest,
    result,

    // estados de carga/erro
    catalogError,
    sessionError,
    expired,
    booting: !session && !sessionError && !expired,
    catalogLoading: !catalog && !catalogError,
    amountSyncing,
    syncFailed,
    savingIdentity,
    savingPlan,
    submitting,

    // passos
    activeStep,
    completed,
    stepState,
    editStep,

    // valores
    totalCents,
    alreadySubmitted: !!session?.paymentAt,
    concluded: session?.status === 'paid',

    // ações
    retryCatalog,
    retrySession,
    startOver,
    choosePlan,
    changeScreens,
    retrySync,
    setIdentityField,
    setDocumentKind,
    blurIdentityField,
    submitIdentify,
    confirmPlan,
    finish,
    planError,
  };
}

export type CheckoutController = ReturnType<typeof useCheckout>;
