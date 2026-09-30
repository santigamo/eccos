/**
 * The product facts the site states more than once, stated once.
 *
 * The FAQ band, the JSON-LD and /llms.txt all read from here. The reason is a
 * failure mode measured on transcribo.es: a hand-written llms.txt kept saying
 * "if we ever charge" months after payments went live, so the file an answer
 * engine quotes contradicted the page a human reads. Anything quotable lives
 * here, once, and every surface derives from it.
 *
 * Prices and data guarantees below are the ones published on the landing
 * (apps/site/src/page-content/landing*.html). Change them together.
 */

export type Locale = "es" | "en";

export const SITE = {
  url: "https://eccos.chat",
  repo: "https://github.com/santigamo/eccos",
  signup: "https://app.eccos.chat/signup",
  email: "hello@imsanti.dev",
  provider: "Santiago García Monsalve",
  location: "Manresa (Barcelona), Spain",
  license: "MIT",
  licenseUrl: "https://github.com/santigamo/eccos/blob/main/LICENSE",
} as const;

/** Eccos Cloud tariff. One metric: the connected number. Messages are never billed. */
export const PRICING = {
  currency: "EUR",
  firstNumber: 5,
  tiers: [
    { numbers: "1", monthly: 5 },
    { numbers: "2–5", monthly: 3, per: "number" },
    { numbers: "6–15", monthly: 19, flat: true },
    { numbers: "16–50", monthly: 49, flat: true },
    { numbers: "51+", monthly: 49, plusPerNumber: 1 },
  ],
} as const;

/** Retention and jurisdiction, as published in the landing's data table. */
export const DATA_TERMS = {
  contentRetentionDays: 30,
  contentRetentionMinDays: 7,
  contentRetentionMaxDays: 90,
  jurisdiction: "Cloudflare's European jurisdiction",
} as const;

interface Copy {
  /** One self-contained sentence: the definition an answer engine can quote. */
  definition: string;
  features: string[];
  /** What Eccos is not — the rivals in the same queries are unofficial clients. */
  isNot: string[];
  faq: { q: string; a: string }[];
}

export const COPY: Record<Locale, Copy> = {
  en: {
    definition:
      "Eccos is an open-source (MIT) WhatsApp gateway on Meta's official WhatsApp Cloud API: it connects one or fifty numbers — yours or your clients' — relays every event between Meta and your systems, and is priced per connected number, never per message.",
    features: [
      "Built on Meta's official WhatsApp Cloud API — no WhatsApp Web automation, no ban risk",
      "Coexistence: the business keeps answering from the phone while the API sends and receives on the same number",
      "Normalized inbound messages and delivery statuses forwarded to your backend, HMAC-signed and retried with exponential backoff",
      "Send messages, templates and media through a small, stable HTTP surface",
      "Embedded Signup onboarding so each business connects its own number",
      "Operator console for status, message and event logs, and the forwarding queue",
      "Per-number GDPR erasure endpoint",
      "Runs as a single Bun binary, in Docker, or entirely on Cloudflare Workers + Durable Objects — no external database or queue",
      "MIT-licensed and self-hostable: your Meta app, your token, your infrastructure",
    ],
    isNot: [
      "Eccos is not a message reseller: it never meters or marks up messages, and Meta bills each business directly for its own conversations.",
      "Eccos does not use WhatsApp Web or any reverse-engineered client, unlike Evolution API, WAHA or OpenWA. It calls Meta's official Cloud API.",
      "Eccos is not a chatbot builder and has no visual flow editor: it is a gateway, and your application owns the conversation logic.",
      "Eccos is not a shared team inbox or a CRM. The operator console exists for operational visibility, not for day-to-day customer chat.",
      "Eccos is an independent project, not affiliated with, endorsed by or sponsored by Meta Platforms.",
    ],
    faq: [
      {
        q: "Can my WhatsApp number get banned for using Eccos?",
        a: "No. Eccos runs on Meta's official WhatsApp Cloud API, not on WhatsApp Web automation, so there is no reverse-engineered session for WhatsApp's anti-abuse systems to detect. That is the difference from unofficial gateways such as Evolution API, WAHA or OpenWA, which drive a reverse-engineered client and carry a real risk of restriction.",
      },
      {
        q: "What is coexistence, and does Eccos support it?",
        a: "Coexistence lets a business keep answering from the WhatsApp Business app on the phone while the same number also sends and receives through the Cloud API. Eccos supports it and forwards the staff's manual replies to your backend as echo events, so your system sees the whole conversation and not just what it sent. Twilio cannot do this, because it requires a number that is not already registered on WhatsApp.",
      },
      {
        q: "What does Eccos cost, and what do I pay Meta?",
        a: "Eccos Cloud is priced per connected number: 5 € a month for the first number, +3 € for numbers 2 to 5, 19 € flat for 6 to 15 and 49 € flat for 16 to 50. Messages are unlimited on every plan and Eccos never meters them; Meta charges each business directly for its own conversations, with that business's own payment method. Eccos Cloud is in early access, so accounts are free and nothing is billed while that lasts, and self-hosting is free under the MIT licence.",
      },
      {
        q: "Can I self-host Eccos, or move from Eccos Cloud to my own server?",
        a: "Yes, both. Eccos is MIT-licensed and runs as a single Bun binary, in Docker, or entirely on Cloudflare Workers with Durable Objects, with no external database or queue. Moving off Eccos Cloud is documented step by step at https://eccos.chat/migrate, including what cannot be exported.",
      },
      {
        q: "Do you store my messages?",
        a: "On Eccos Cloud, message content is kept 30 days by default and is configurable between 7 and 90 days, with storage pinned to Cloudflare's European jurisdiction. Data is never cross-referenced between businesses, never sold or shared with data brokers, and never used for advertising or to train models; per-number erasure is available through the API. Self-hosted, none of it reaches us at all.",
      },
      {
        q: "Do I need my own Meta app, or to become a Tech Provider?",
        a: "Self-hosting, you bring your own Meta app and WhatsApp Business Account, and Eccos holds those credentials so your apps only talk to its HTTP surface. On Eccos Cloud you do not: Meta has reviewed and approved the Eccos app, so a business connects its own number through Embedded Signup without becoming a Tech Provider itself.",
      },
    ],
  },
  es: {
    definition:
      "Eccos es un gateway de WhatsApp de código abierto (MIT) sobre la Cloud API oficial de Meta: conecta uno o cincuenta números —tuyos o de tus clientes—, retransmite todos los eventos entre Meta y tus sistemas y se cobra por número conectado, nunca por mensaje.",
    features: [
      "Sobre la API Cloud oficial de Meta: sin automatización de WhatsApp Web y sin riesgo de baneo",
      "Coexistence: la empresa sigue respondiendo desde el teléfono mientras la API envía y recibe en el mismo número",
      "Mensajes entrantes y estados de entrega normalizados y reenviados a tu backend, firmados con HMAC y reintentados con retroceso exponencial",
      "Envío de mensajes, plantillas y multimedia por una superficie HTTP pequeña y estable",
      "Alta con Embedded Signup para que cada empresa conecte su propio número",
      "Consola de operador con estado, registros de mensajes y eventos, y la cola de reenvío",
      "Borrado por número para el artículo 17 del RGPD",
      "Se ejecuta como un binario de Bun, en Docker o entero sobre Cloudflare Workers + Durable Objects, sin base de datos ni cola externas",
      "Licencia MIT y autoalojable: tu app de Meta, tu token, tu infraestructura",
    ],
    isNot: [
      "Eccos no revende mensajes: nunca los cuenta ni les aplica margen, y Meta factura a cada empresa directamente sus propias conversaciones.",
      "Eccos no usa WhatsApp Web ni ningún cliente de ingeniería inversa, al contrario que Evolution API, WAHA u OpenWA. Llama a la Cloud API oficial de Meta.",
      "Eccos no es un constructor de chatbots ni tiene editor visual de flujos: es un gateway, y la lógica de la conversación es de tu aplicación.",
      "Eccos no es un buzón compartido ni un CRM. La consola de operador existe para visibilidad operativa, no para atender el día a día.",
      "Eccos es un proyecto independiente y no está afiliado, respaldado ni patrocinado por Meta Platforms.",
    ],
    faq: [
      {
        q: "¿Pueden banear mi número de WhatsApp por usar Eccos?",
        a: "No. Eccos funciona sobre la Cloud API oficial de Meta, no sobre automatización de WhatsApp Web, así que no hay ninguna sesión de ingeniería inversa que los sistemas antiabuso de WhatsApp puedan detectar. Es la diferencia con los gateways no oficiales como Evolution API, WAHA u OpenWA, que manejan un cliente de ingeniería inversa y sí tienen riesgo real de restricción.",
      },
      {
        q: "¿Qué es coexistence y Eccos lo admite?",
        a: "Coexistence permite que una empresa siga respondiendo desde la app de WhatsApp Business en el teléfono mientras el mismo número envía y recibe también por la Cloud API. Eccos lo admite y reenvía a tu backend las respuestas manuales del equipo como eventos echo, así que tu sistema ve la conversación completa y no solo lo que él envió. Twilio no puede hacerlo porque exige un número que no esté ya registrado en WhatsApp.",
      },
      {
        q: "¿Cuánto cuesta Eccos y qué le pago a Meta?",
        a: "Eccos Cloud se cobra por número conectado: 5 € al mes el primero, +3 € los números 2 a 5, 19 € fijos de 6 a 15 y 49 € fijos de 16 a 50. Los mensajes son ilimitados en todos los planes y Eccos no los cuenta nunca; Meta cobra a cada empresa directamente sus propias conversaciones, con el método de pago de esa empresa. Eccos Cloud está en acceso anticipado, así que las cuentas son gratis y no se factura nada mientras dure, y autoalojarlo es gratis bajo licencia MIT.",
      },
      {
        q: "¿Puedo autoalojar Eccos o pasar de Eccos Cloud a mi propio servidor?",
        a: "Sí, las dos cosas. Eccos tiene licencia MIT y se ejecuta como un binario de Bun, en Docker o entero sobre Cloudflare Workers con Durable Objects, sin base de datos ni cola externas. La salida de Eccos Cloud está documentada paso a paso en https://eccos.chat/migrate, incluido lo que no se puede exportar.",
      },
      {
        q: "¿Guardáis mis mensajes?",
        a: "En Eccos Cloud el contenido de los mensajes se conserva 30 días por defecto y es configurable entre 7 y 90, con el almacenamiento fijado a la jurisdicción europea de Cloudflare. Los datos no se cruzan nunca entre empresas, no se venden ni se comparten con intermediarios de datos y no se usan para publicidad ni para entrenar modelos; hay borrado por número a través de la API. Autoalojado, nada de eso llega a nosotros.",
      },
      {
        q: "¿Necesito mi propia app de Meta o ser Tech Provider?",
        a: "Autoalojándolo, traes tu propia app de Meta y tu cuenta de WhatsApp Business, y Eccos guarda esas credenciales para que tus aplicaciones solo hablen con su superficie HTTP. En Eccos Cloud no hace falta: Meta ha revisado y aprobado la app de Eccos, así que una empresa conecta su propio número con Embedded Signup sin tener que ser Tech Provider ella misma.",
      },
    ],
  },
};

/** Every indexable page, with the question it answers — the shape llms.txt wants. */
export const PAGES: { url: string; title: string; answers: string }[] = [
  {
    url: "https://eccos.chat/en",
    title: "Eccos — open-source WhatsApp gateway (English)",
    answers:
      "What Eccos is, how inbound and outbound messages flow, the per-number pricing, the two ways to run it, and how data is handled.",
  },
  {
    url: "https://eccos.chat/",
    title: "Eccos — gateway de WhatsApp de código abierto (Spanish)",
    answers: "The same landing in Spanish; this is the site's default language.",
  },
  {
    url: "https://eccos.chat/migrate",
    title: "Migration guide: Eccos Cloud to self-host",
    answers:
      "How to leave Eccos Cloud for your own infrastructure: what moves, what cannot be exported, and the order of the cutover.",
  },
  {
    url: "https://eccos.chat/privacy",
    title: "Privacy policy",
    answers:
      "What data Eccos Cloud processes, retention windows, storage jurisdiction, subprocessors and data-subject rights.",
  },
  {
    url: "https://eccos.chat/terms",
    title: "Terms of service",
    answers: "The terms Eccos Cloud is offered under, including the early-access status.",
  },
  {
    url: "https://eccos.chat/data-deletion",
    title: "Data deletion",
    answers: "How a business or an end user requests deletion of their data, and what gets deleted.",
  },
  {
    url: "https://github.com/santigamo/eccos",
    title: "Source repository (GitHub, MIT)",
    answers:
      "The code, the HTTP API reference, the quickstarts for Bun, Docker and Cloudflare Workers, and the architecture documents.",
  },
];
