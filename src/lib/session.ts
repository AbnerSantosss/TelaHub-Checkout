// Cliente da sessão pública de checkout.
//
// A sessão nasce na PRIMEIRA visita, antes de qualquer dado pessoal: é isso que
// torna o abandono mensurável por etapa. Cada passo concluído é um PATCH, e o
// valor devolvido pelo servidor é o único válido.
import { api } from './api';

export type CheckoutStatus =
  | 'started'
  | 'identified'
  | 'payment_pending'
  | 'paid'
  | 'abandoned'
  | 'expired';

/** Sessão como o comprador pode vê-la: nada de id interno, org ou atribuição. */
export interface CheckoutSession {
  publicToken: string;
  status: CheckoutStatus;
  planCode: string | null;
  screens: number;
  amountCents: number;
  currency: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  document: string | null;
  companyName: string | null;
  startedAt: string | null;
  lastSeenAt: string | null;
  identifiedAt: string | null;
  paymentAt: string | null;
  expiresAt: string | null;
}

/** Atribuição de campanha capturada na chegada. Alimenta o relatório do funil. */
export interface Attribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  referrer?: string;
}

export interface UpdateSessionInput {
  planCode?: string;
  screens?: number;
  name?: string;
  email?: string;
  phone?: string;
  document?: string;
  companyName?: string;
}

/**
 * Resultado do `submit`. Hoje `charged` é sempre `false`: não há gateway
 * integrado, então a sessão só vai para "aguardando pagamento".
 */
export interface CheckoutPaymentResult {
  status: string;
  gateway: string | null;
  nextStep: string;
  charged: boolean;
  message: string;
}

const FALLBACK_MESSAGE =
  'Recebemos sua solicitação. Nenhuma cobrança foi feita: nosso time comercial entra em ' +
  'contato pelo e-mail e telefone informados para confirmar o plano e enviar o pagamento.';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const STATUSES: CheckoutStatus[] = [
  'started',
  'identified',
  'payment_pending',
  'paid',
  'abandoned',
  'expired',
];

/**
 * A rota devolve `{ session }`; aceitar também o objeto solto evita que uma
 * diferença de envelope entre versões do backend derrube a tela.
 */
function normalizeSession(payload: unknown): CheckoutSession {
  const envelope = asRecord(payload);
  const raw = asRecord('session' in envelope ? envelope.session : envelope);

  const publicToken = optionalText(raw.publicToken);
  if (!publicToken) {
    throw new Error('Resposta de sessão inválida: token público ausente.');
  }

  const status = STATUSES.find((candidate) => candidate === raw.status) ?? 'started';

  return {
    publicToken,
    status,
    planCode: optionalText(raw.planCode),
    screens:
      typeof raw.screens === 'number' && Number.isFinite(raw.screens)
        ? Math.max(1, Math.floor(raw.screens))
        : 1,
    amountCents:
      typeof raw.amountCents === 'number' && Number.isFinite(raw.amountCents)
        ? raw.amountCents
        : 0,
    currency: optionalText(raw.currency) ?? 'BRL',
    name: optionalText(raw.name),
    email: optionalText(raw.email),
    phone: optionalText(raw.phone),
    document: optionalText(raw.document),
    companyName: optionalText(raw.companyName),
    startedAt: optionalText(raw.startedAt),
    lastSeenAt: optionalText(raw.lastSeenAt),
    identifiedAt: optionalText(raw.identifiedAt),
    paymentAt: optionalText(raw.paymentAt),
    expiresAt: optionalText(raw.expiresAt),
  };
}

export const createSession = async (input: Attribution = {}): Promise<CheckoutSession> =>
  normalizeSession(await api.post<unknown>('/checkout/sessions', input));

export const getSession = async (publicToken: string): Promise<CheckoutSession> =>
  normalizeSession(await api.get<unknown>(`/checkout/sessions/${encodeURIComponent(publicToken)}`));

export const updateSession = async (
  publicToken: string,
  input: UpdateSessionInput
): Promise<CheckoutSession> =>
  normalizeSession(
    await api.patch<unknown>(`/checkout/sessions/${encodeURIComponent(publicToken)}`, input)
  );

export const submitSession = async (
  publicToken: string,
  input: { paymentMethod?: string; note?: string } = {}
): Promise<{ session: CheckoutSession; payment: CheckoutPaymentResult }> => {
  const payload = asRecord(
    await api.post<unknown>(
      `/checkout/sessions/${encodeURIComponent(publicToken)}/submit`,
      input
    )
  );
  const payment = asRecord(payload.payment);

  return {
    session: normalizeSession(payload),
    payment: {
      status: optionalText(payment.status) ?? 'manual',
      gateway: optionalText(payment.gateway),
      nextStep: optionalText(payment.nextStep) ?? 'contato-comercial',
      charged: payment.charged === true,
      message: optionalText(payment.message) ?? FALLBACK_MESSAGE,
    },
  };
};

const UTM_KEYS: Array<[string, keyof Attribution]> = [
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_content', 'utmContent'],
  ['utm_term', 'utmTerm'],
];

/**
 * Atribuição da visita: UTMs da query string + `document.referrer`. Precisa ser
 * lida ANTES de a URL ser reescrita com o token, senão a origem do lead se
 * perde e o relatório por campanha fica cego.
 */
export function readAttribution(): Attribution {
  const attribution: Attribution = {};
  try {
    const params = new URLSearchParams(window.location.search);
    for (const [param, key] of UTM_KEYS) {
      const value = params.get(param);
      if (value && value.trim()) attribution[key] = value.trim().slice(0, 200);
    }
    if (document.referrer) attribution.referrer = document.referrer.slice(0, 1000);
  } catch {
    // Ambiente sem `location`/`document` utilizável: segue sem atribuição.
  }
  return attribution;
}

/** Plano e telas sugeridos pelo link (ex.: vindo da página de preços). */
export function readSelectionHint(): { planCode: string | null; screens: number | null } {
  try {
    const params = new URLSearchParams(window.location.search);
    const plan = params.get('plan') ?? params.get('planCode');
    const screens = params.get('screens') ?? params.get('telas');
    const parsed = screens ? Number.parseInt(screens, 10) : Number.NaN;
    return {
      planCode: plan && /^[a-z][a-z0-9-]{0,59}$/i.test(plan) ? plan.toLowerCase() : null,
      screens: Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1000) : null,
    };
  } catch {
    return { planCode: null, screens: null };
  }
}

/**
 * Troca `/c` por `/c/<token>` SEM criar entrada no histórico: um "voltar" que
 * caísse numa rota sem token criaria uma segunda sessão e duplicaria o lead no
 * relatório. Preserva a query string (atribuição continua visível/depurável).
 */
export function replaceUrlWithToken(publicToken: string): void {
  try {
    const url = new URL(window.location.href);
    url.pathname = `/c/${publicToken}`;
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Sem History API: a URL fica como está; a sessão em memória segue válida.
  }
}
