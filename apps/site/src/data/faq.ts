/**
 * The /faq page: the landing's questions plus the pre-sales ones prospects keep
 * emailing, grouped by topic. Landing items are reused by reference, so the
 * page can tell them apart and leave their FAQPage markup to the landing.
 */
import { COPY, PRICING, SITE, type Locale } from "./product";

export interface FaqItem {
  q: string;
  a: string;
}

export interface FaqGroup {
  id: string;
  title: string;
  items: FaqItem[];
}

const [enBan, enCoexistence, enCost, enOfficial, enCompare, enSelfHost, , enMetaApp] = COPY.en.faq;
const [esBan, esCoexistence, esCost, esOfficial, esCompare, esSelfHost, , esMetaApp] = COPY.es.faq;

const setupHours = PRICING.setupWindowHours;

export const FAQ_PAGE: Record<Locale, FaqGroup[]> = {
  en: [
    {
      id: "pricing",
      title: "Price and payment",
      items: [
        enCost,
        {
          q: "Is everything included in the monthly price, or are there setup or per-message fees?",
          a: "The monthly price per connected number is all Eccos charges. There is no setup fee and no fee per message: messages are unlimited on every plan. Prices do not include VAT, which is added at checkout. The only other cost is what Meta charges for some messages, which Meta bills to your business directly.",
        },
        {
          q: "Does Meta charge extra for template messages?",
          a: "Yes. Template messages, the ones a business sends to start a conversation, are charged by Meta at its own rates, by country and category (marketing, utility, authentication). Replies inside the 24-hour window after a customer writes to you are free up to 1,000 per number each month; Meta charges for them after that. Meta bills these fees to the payment method in your business's own WhatsApp Business Account. Eccos does not take part in that bill and adds nothing on top.",
        },
        {
          q: "Can I try Eccos before paying?",
          a: `Yes. Connect your number first, and pay only once it works. You sign up and connect your first number with no card. It works when its first message is delivered, or when your software receives its first message from Eccos. From that moment you have ${setupHours} hours to finish setting up and subscribe; if you do not, the number is paused until you do, and incoming messages are kept in the meantime. If it never works, you never pay. A second number needs the subscription. You can cancel at any time from the billing section of the console.`,
        },
        enCompare,
      ],
    },
    {
      id: "meta",
      title: "Meta account, verification and billing",
      items: [
        {
          q: "Do I need any other provider besides Eccos?",
          a: "No. You need a Meta business account with a WhatsApp Business Account, which you can create while connecting the number, and a payment method in Meta for the messages Meta charges for. Eccos covers the rest: the connection to the official API, the console, the API and the webhooks.",
        },
        {
          q: "Do I need Meta business verification to start?",
          a: "No. Without verification, Meta lets a business start conversations with up to 250 different customers in a rolling 24 hours, using template messages, shared by all the numbers in its business portfolio. Verifying the business, or delivering 2,000 good-quality template messages within 30 days, raises it to 2,000. After that it goes up automatically as you use it. Each company verifies itself, in its own Meta business portfolio; Eccos does not need to do anything.",
        },
        enOfficial,
        {
          q: "What happens if Meta suspends the Eccos app?",
          a: "Your number, your WhatsApp Business Account and your Meta billing belong to your business, so they stay yours. The WhatsApp Business app on your phone does not depend on Eccos. Sending and receiving through the API would stop. To move to another provider, or to Eccos on your own server, you disconnect Eccos in the app and connect the number again through the new provider.",
        },
        {
          q: "Can each business pay Meta separately, or can I pay for all of them in one place?",
          a: "Each business pays Meta with its own payment method, in its own WhatsApp Business Account. Paying Meta in one place for several businesses needs a Solution Partner's credit line. Eccos is a Tech Provider and does not offer one today.",
        },
      ],
    },
    {
      id: "phone",
      title: "Your number and the WhatsApp app",
      items: [
        enCoexistence,
        {
          q: "Does coexistence work in my country?",
          a: "Coexistence works in every country where Meta offers it; Eccos adds no restriction of its own. If your number is not eligible, the connection screen will tell you. The app has to be WhatsApp Business (not personal WhatsApp), version 2.24.17 or higher, and Meta disconnects the number if the app goes about 14 days without being opened. Meta's conditions are at https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users",
        },
        {
          q: "Do messages I send from the phone or from WhatsApp Web reach my system?",
          a: "Yes, on a number connected with coexistence. What your team sends from the WhatsApp Business app, or from WhatsApp Web linked to it, reaches your system as an echo event, so your software knows when someone has already answered by hand. Messages sent from WhatsApp for Windows are not mirrored.",
        },
        enBan,
        {
          q: "If I stop using Eccos, do I keep my number and the app?",
          a: "Yes. The number and the WhatsApp Business Account belong to your business. If you leave, only the API connection through Eccos goes away: the app keeps working on your phone as before, and nothing has to be migrated or registered again. The conversation history stored in Eccos is deleted when you close the account, so export what you need first.",
        },
      ],
    },
    {
      id: "api",
      title: "Sending and receiving from your own systems",
      items: [
        {
          q: "Can I send messages from my own server or script?",
          a: "Yes. Any program that can make an HTTPS request can send: a Python script, a server, a NAS or an automation tool. In the console, open API keys (under Setup, for an owner or admin) and create a key. Your program then sends a POST request to the Eccos API with that key and the message. The guide, with an example, is at https://docs.eccos.chat/sending-messages.",
        },
        {
          q: "Do I need a VPS or a public server?",
          a: "Not to send. Sending is an outgoing HTTPS request, so it works from any machine with internet access, including a computer or a NAS in your office. To receive messages on your own system, you need a public HTTPS address that Eccos can call. If your machine is not public, a tunnel such as Cloudflare Tunnel gives it one. To read and answer conversations by hand you need no server at all: the console has an inbox.",
        },
        {
          q: "Can I receive messages on my own HTTPS endpoint, and are the requests signed?",
          a: "Yes. In the console, under Webhooks, set your HTTPS address and a signing secret. Every request is signed with that secret (HMAC-SHA256 of the body), so your system can check that it comes from Eccos. If your endpoint is down, Eccos retries for about an hour, and you can resend a failed batch from the console. Details are at https://docs.eccos.chat/webhooks.",
        },
        {
          q: "Is there a limit on how many messages I can send?",
          a: "Eccos does not limit how many messages you send in total: they are unlimited on every plan. The API sends up to 60 messages per minute per WhatsApp Business Account by default, and the limit can be raised on request. Meta has its own limits on how many customers you can contact first, which grow with verification and use.",
        },
        {
          q: "Can several people use one number, or can I manage several companies?",
          a: "Yes, both. You invite your team to a workspace, with different permissions, and everyone reads and answers the same conversations in the console, while the phone keeps working with coexistence. For several companies, create one workspace per company: each one sees only its own numbers, conversations and settings, and you switch between them in the console. Each workspace has its own subscription.",
        },
      ],
    },
    {
      id: "privacy",
      title: "Data and GDPR",
      items: [
        {
          q: "Do you sign a data processing agreement under Article 28 of the GDPR?",
          a: `Yes. On Eccos Cloud your business is the data controller and Eccos is the processor, under Article 28 of the GDPR. The agreement is available on request at ${SITE.email}.`,
        },
        {
          q: "Where is my data stored, and who else processes it?",
          a: "Eccos Cloud stores data in Cloudflare's European Union jurisdiction. The providers that process it for us are Cloudflare (hosting), Sentry (error reports, with no message content) and Hetzner (a fallback server in Germany that only relays traffic and stores none of it). Every message also goes through Meta's WhatsApp API, which processes messages in its own data centres, in the United States by default; your business has its own account and contract with Meta, so Meta is your provider, not a subprocessor of Eccos. The full list is in the privacy policy, at https://eccos.chat/privacy.",
        },
        {
          q: "How long do you keep my data, and can I turn storage off?",
          a: "Conversation history is kept with no time limit by default; in Settings you can have it deleted automatically after a window, from 30 days up. The copy used to deliver events to your system deletes message content after 30 days by default. Storage cannot be switched off completely, but you can erase a customer's data at any time, by phone number.",
        },
      ],
    },
    {
      id: "self-host",
      title: "Self-hosting",
      items: [
        enSelfHost,
        {
          q: "If I move to self-hosted later, do I have to register my numbers again?",
          a: "No. The number and the WhatsApp Business Account stay yours, so you connect them to your own deployment through your own Meta app, without registering the number again. Conversation history does not move by itself: export it from Eccos Cloud before you leave. The steps are at https://eccos.chat/migrate.",
        },
        enMetaApp,
      ],
    },
  ],
  es: [
    {
      id: "pricing",
      title: "Precio y pago",
      items: [
        esCost,
        {
          q: "¿El precio mensual lo incluye todo, o hay cuota de alta o cobro por mensaje?",
          a: "El precio mensual por número conectado es todo lo que cobra Eccos. No hay cuota de alta ni cobro por mensaje: los mensajes son ilimitados en todos los planes. Los precios no incluyen el IVA, que se añade al pagar. El único coste aparte es lo que Meta cobra por algunos mensajes, y eso te lo factura Meta directamente.",
        },
        {
          q: "¿Meta cobra aparte por los mensajes de plantilla?",
          a: "Sí. Los mensajes de plantilla, los que envía una empresa para iniciar una conversación, los cobra Meta con sus propias tarifas, según el país y la categoría (marketing, utilidad, autenticación). Las respuestas dentro de las 24 horas siguientes a que un cliente te escriba son gratis hasta 1.000 por número al mes; a partir de ahí Meta las cobra. Meta cobra esas tarifas al método de pago de la cuenta de WhatsApp Business de tu empresa. Eccos no participa en esa factura ni añade nada encima.",
        },
        {
          q: "¿Puedo probar Eccos antes de pagar?",
          a: `Sí. Conecta tu número primero y paga solo cuando funcione. Te registras y conectas tu primer número sin tarjeta. Funciona cuando se entrega su primer mensaje, o cuando tu software recibe el primero desde Eccos. Desde ese momento tienes ${setupHours} horas para terminar la configuración y suscribirte; si no lo haces, el número queda en pausa hasta que te suscribas, y los mensajes que te lleguen se guardan mientras tanto. Si nunca llega a funcionar, no pagas nada. Un segundo número necesita la suscripción. Puedes cancelar cuando quieras desde la sección de facturación de la consola.`,
        },
        esCompare,
      ],
    },
    {
      id: "meta",
      title: "Cuenta de Meta, verificación y facturación",
      items: [
        {
          q: "¿Necesito algún otro proveedor además de Eccos?",
          a: "No. Necesitas una cuenta de empresa en Meta con una cuenta de WhatsApp Business, que puedes crear al conectar el número, y un método de pago en Meta para los mensajes que cobra Meta. Eccos pone el resto: la conexión con la API oficial, la consola, la API y los webhooks.",
        },
        {
          q: "¿Necesito verificar mi empresa en Meta para empezar?",
          a: "No. Sin verificar, Meta deja a una empresa iniciar conversaciones con hasta 250 clientes distintos en 24 horas móviles, con mensajes de plantilla, compartidos por todos los números de su portfolio de empresa. Verificar la empresa, o entregar 2.000 mensajes de plantilla de buena calidad en 30 días, lo sube a 2.000. Después sube solo a medida que lo usas. Cada empresa se verifica ella misma, en su propio portfolio de empresa de Meta; Eccos no tiene que hacer nada.",
        },
        esOfficial,
        {
          q: "¿Qué pasa si Meta suspende la app de Eccos?",
          a: "Tu número, tu cuenta de WhatsApp Business y tu facturación con Meta son de tu empresa, así que siguen siendo tuyos. La app de WhatsApp Business del teléfono no depende de Eccos. Lo que se pararía es el envío y la recepción por la API. Para pasarte a otro proveedor, o a Eccos en tu propio servidor, desconectas Eccos en la app y vuelves a conectar el número con el nuevo proveedor.",
        },
        {
          q: "¿Cada empresa puede pagar a Meta por separado, o puedo pagarlo todo desde un sitio?",
          a: "Cada empresa paga a Meta con su propio método de pago, en su propia cuenta de WhatsApp Business. Pagar a Meta desde un solo sitio por varias empresas requiere la línea de crédito de un Solution Partner. Eccos es Tech Provider y hoy no la ofrece.",
        },
      ],
    },
    {
      id: "phone",
      title: "Tu número y la app de WhatsApp",
      items: [
        esCoexistence,
        {
          q: "¿La coexistencia funciona en mi país?",
          a: "La coexistencia funciona en todos los países donde Meta la ofrece; Eccos no añade ninguna restricción. Si tu número no es apto, te lo dirá la pantalla de conexión. Tiene que ser la app de WhatsApp Business (no el WhatsApp personal), versión 2.24.17 o superior, y Meta desconecta el número si la app pasa unos 14 días sin abrirse. Las condiciones de Meta están en https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users",
        },
        {
          q: "¿Los mensajes que envío desde el teléfono o desde WhatsApp Web llegan a mi sistema?",
          a: "Sí, en un número conectado con coexistencia. Lo que tu equipo envía desde la app de WhatsApp Business, o desde WhatsApp Web vinculado a ella, llega a tu sistema como evento echo, así que tu software sabe cuándo alguien ya ha contestado a mano. Lo que se envía desde WhatsApp para Windows no se refleja.",
        },
        esBan,
        {
          q: "Si dejo de usar Eccos, ¿conservo mi número y la app?",
          a: "Sí. El número y la cuenta de WhatsApp Business son de tu empresa. Si te vas, solo desaparece la conexión a la API a través de Eccos: la app sigue funcionando en tu teléfono como siempre y no hay que migrar ni volver a registrar nada. El historial de conversaciones guardado en Eccos se borra al cerrar la cuenta, así que exporta antes lo que necesites.",
        },
      ],
    },
    {
      id: "api",
      title: "Enviar y recibir desde tus propios sistemas",
      items: [
        {
          q: "¿Puedo enviar mensajes desde mi propio servidor o script?",
          a: "Sí. Cualquier programa que pueda hacer una petición HTTPS puede enviar: un script de Python, un servidor, un NAS o una herramienta de automatización. En la consola, abre API keys (en Setup, para el propietario o un administrador) y crea una clave. Tu programa envía después una petición POST a la API de Eccos con esa clave y el mensaje. La guía, con un ejemplo, está en https://docs.eccos.chat/sending-messages.",
        },
        {
          q: "¿Necesito un VPS o un servidor público?",
          a: "Para enviar, no. Enviar es una petición HTTPS de salida, así que funciona desde cualquier máquina con internet, también un ordenador o un NAS en tu oficina. Para recibir los mensajes en tu propio sistema necesitas una dirección HTTPS pública a la que Eccos pueda llamar. Si tu máquina no es pública, un túnel como Cloudflare Tunnel le da una. Para leer y contestar conversaciones a mano no necesitas ningún servidor: la consola tiene una bandeja de entrada.",
        },
        {
          q: "¿Puedo recibir los mensajes en mi propio endpoint HTTPS? ¿Las peticiones van firmadas?",
          a: "Sí. En la consola, en Webhooks, indicas tu dirección HTTPS y un secreto de firma. Cada petición va firmada con ese secreto (HMAC-SHA256 del cuerpo), así que tu sistema puede comprobar que viene de Eccos. Si tu endpoint está caído, Eccos reintenta durante una hora aproximadamente, y puedes reenviar un lote fallido desde la consola. Los detalles están en https://docs.eccos.chat/webhooks.",
        },
        {
          q: "¿Hay un límite de mensajes?",
          a: "Eccos no limita cuántos mensajes envías en total: son ilimitados en todos los planes. La API envía hasta 60 mensajes por minuto por cuenta de WhatsApp Business por defecto, y el límite se puede ampliar si lo pides. Meta tiene sus propios límites sobre a cuántos clientes puedes escribir primero, que crecen con la verificación y el uso.",
        },
        {
          q: "¿Pueden usar un número varias personas? ¿Puedo gestionar varias empresas?",
          a: "Sí, las dos cosas. Invitas a tu equipo a un espacio de trabajo, con distintos permisos, y todos leen y contestan las mismas conversaciones en la consola, mientras el teléfono sigue funcionando con coexistencia. Para varias empresas, crea un espacio de trabajo por empresa: cada uno ve solo sus números, sus conversaciones y su configuración, y cambias de uno a otro en la consola. Cada espacio de trabajo tiene su propia suscripción.",
        },
      ],
    },
    {
      id: "privacy",
      title: "Datos y RGPD",
      items: [
        {
          q: "¿Firmáis un contrato de encargo del tratamiento (artículo 28 del RGPD)?",
          a: `Sí. En Eccos Cloud tu empresa es la responsable del tratamiento y Eccos es el encargado, según el artículo 28 del RGPD. El contrato está disponible si lo pides en ${SITE.email}.`,
        },
        {
          q: "¿Dónde se guardan mis datos y quién más los trata?",
          a: "Eccos Cloud guarda los datos en la jurisdicción de la Unión Europea de Cloudflare. Los proveedores que los tratan por nuestra cuenta son Cloudflare (alojamiento), Sentry (informes de errores, sin contenido de mensajes) y Hetzner (un servidor de respaldo en Alemania que solo retransmite tráfico y no guarda nada). Todos los mensajes pasan además por la API de WhatsApp de Meta, que los procesa en sus propios centros de datos, en Estados Unidos por defecto; tu empresa tiene su propia cuenta y su propio contrato con Meta, así que Meta es tu proveedor y no un subencargado de Eccos. La lista completa está en la política de privacidad, en https://eccos.chat/privacy.",
        },
        {
          q: "¿Cuánto tiempo guardáis mis datos? ¿Puedo desactivar el almacenamiento?",
          a: "El historial de conversaciones se guarda sin límite de tiempo por defecto; en Settings puedes hacer que se borre solo pasado un plazo, a partir de 30 días. La copia que sirve para entregar los eventos a tu sistema borra el contenido de los mensajes a los 30 días por defecto. El almacenamiento no se puede desactivar del todo, pero puedes borrar los datos de un cliente cuando quieras, por número de teléfono.",
        },
      ],
    },
    {
      id: "self-host",
      title: "Autoalojamiento",
      items: [
        esSelfHost,
        {
          q: "Si más adelante paso a autoalojarlo, ¿tengo que volver a registrar mis números?",
          a: "No. El número y la cuenta de WhatsApp Business siguen siendo tuyos, así que los conectas a tu propia instalación con tu propia app de Meta, sin volver a registrar el número. El historial de conversaciones no se mueve solo: expórtalo de Eccos Cloud antes de irte. Los pasos están en https://eccos.chat/migrate.",
        },
        esMetaApp,
      ],
    },
  ],
};
