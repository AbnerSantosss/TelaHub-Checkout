// Passo 3 — PAGAMENTO.
//
// A anatomia da referência está toda aqui (cards de rádio de Pix, cartão e
// boleto), mas DESATIVADA e com o motivo escrito: não existe gateway integrado,
// então nada é cobrado nesta tela. Quando a cobrança entrar, é ligar cada card —
// não redesenhar o passo.
//
// Nenhum selo de "aprovação imediata": hoje nenhum método aprova nada. Quando o
// Pix estiver integrado, o selo é dele; do boleto, não.
import { Barcode, Check, CreditCard, Info, Mail, QrCode } from 'lucide-react';

import { formatBRL, pluralScreens } from './format';
import { billedScreens } from '../lib/plans';
import { Notice, PrimaryButton } from './primitives';
import type { CheckoutController } from './useCheckout';

/** Mesmo endereço comercial usado na landing do produto. */
const SALES_EMAIL = 'comercial@telahub.com.br';

const METHODS = [
  {
    id: 'pix',
    label: 'Pix',
    icon: QrCode,
    detail: 'Pagamento à vista pelo QR Code.',
  },
  {
    id: 'credit_card',
    label: 'Cartão de crédito',
    icon: CreditCard,
    detail: 'Assinatura com renovação mensal automática.',
  },
  {
    id: 'boleto',
    label: 'Boleto',
    icon: Barcode,
    detail: 'Vencimento em dias úteis, conforme o banco.',
  },
];

export const PaymentStep = ({ checkout }: { checkout: CheckoutController }) => {
  const { selectedPlan, screens, totalCents, finish, submitting, result, alreadySubmitted } =
    checkout;

  const quoteOnly = !!selectedPlan?.quoteOnly;
  const free = !!selectedPlan?.free;
  const billed = selectedPlan ? billedScreens(selectedPlan, screens) : screens;

  if (result) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-xl border border-success/45 bg-success/8 p-4">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success text-white"
          >
            <Check size={17} strokeWidth={3} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-ink">Solicitação enviada</p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{result.message}</p>
          </div>
        </div>

        <dl className="flex flex-col gap-2 rounded-lg bg-app px-3.5 py-3 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-muted">Plano solicitado</dt>
            <dd className="font-bold text-ink">
              {selectedPlan?.name ?? '—'} · {pluralScreens(billed)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-muted">Valor a confirmar</dt>
            <dd className="money font-extrabold text-ink">
              {quoteOnly ? 'Sob consulta' : `${formatBRL(totalCents)}/mês`}
            </dd>
          </div>
        </dl>

        {!result.charged ? (
          <Notice tone="info" icon={<Info size={15} />}>
            <strong className="font-bold">Nenhuma cobrança foi feita.</strong> Nada foi debitado de
            cartão, Pix ou boleto nesta tela.
          </Notice>
        ) : null}

        <a
          href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Contratação TelaHub')}`}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm font-bold text-ink transition-colors hover:border-ink-subtle"
        >
          <Mail aria-hidden="true" size={15} />
          Falar agora com o comercial
        </a>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void finish();
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg bg-app px-3.5 py-3">
        <span className="eyebrow">Total a contratar</span>
        <span className="money text-xl font-extrabold text-success">
          {quoteOnly ? 'Sob consulta' : formatBRL(totalCents)}
          {!quoteOnly ? (
            <span className="ml-1 text-xs font-bold text-ink-muted">/mês</span>
          ) : null}
        </span>
      </div>

      <fieldset className="min-w-0" aria-describedby="checkout-methods-reason">
        <legend className="eyebrow mb-2">Forma de pagamento</legend>

        <div className="flex flex-col gap-2.5">
          {METHODS.map(({ id, label, icon: Icon, detail }) => (
            <label
              key={id}
              aria-disabled="true"
              className="flex cursor-not-allowed gap-3 rounded-xl border border-line bg-app/60 p-3.5"
            >
              <input
                type="radio"
                name="checkout-payment-method"
                value={id}
                disabled
                aria-describedby="checkout-methods-reason"
                className="mt-0.5 size-4 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <Icon aria-hidden="true" size={16} className="shrink-0 text-ink-subtle" />
                  <span className="text-sm font-bold text-ink-muted">{label}</span>
                  <span className="rounded-md bg-line px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-muted">
                    Indisponível
                  </span>
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-ink-subtle">{detail}</span>
              </span>
            </label>
          ))}
        </div>

        <p
          id="checkout-methods-reason"
          className="mt-2.5 text-xs leading-relaxed text-ink-muted"
        >
          Os três métodos estão desativados porque a cobrança automática ainda não está integrada.
          A contratação é concluída pelo nosso time comercial, que envia a forma de pagamento
          combinada com você.
        </p>
      </fieldset>

      <Notice tone="info" icon={<Info size={15} />}>
        <strong className="font-bold">Ao concluir, nada é cobrado.</strong> Sua solicitação fica
        registrada como <em>aguardando pagamento</em> e o comercial entra em contato pelo e-mail e
        WhatsApp que você informou para confirmar o plano
        {free ? '' : ', o valor'} e liberar o acesso.
      </Notice>

      {alreadySubmitted ? (
        <Notice tone="warning" role="status" icon={<Info size={15} />}>
          Esta solicitação já foi enviada antes. Enviar de novo só atualiza o plano e o número de
          telas — não gera cobrança nem duplica contratação.
        </Notice>
      ) : null}

      <PrimaryButton type="submit" busy={submitting} busyLabel="Enviando…">
        {quoteOnly ? 'Solicitar proposta' : 'Concluir e falar com o comercial'}
      </PrimaryButton>
    </form>
  );
};
