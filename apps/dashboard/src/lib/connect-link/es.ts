import type { ConnectLinkCopy } from "./en";

const PAGE_LINKED =
  "Este número está vinculado a una página de Facebook. En Meta Business Suite, abre Configuración, Cuentas, Páginas, quita esa página del portfolio y empieza de nuevo con el mismo enlace.";
const NOT_FROM_APP = "Meta no puede conectar este número desde la app WhatsApp Business. Díselo a quien te envió el enlace.";

const signupErrors: ConnectLinkCopy["signupErrors"] = {
  "3441067":
    "Este número está en una cuenta de WhatsApp Business de un portfolio comercial que no gestionas, a menudo uno creado por otro proveedor de WhatsApp. Pide a ese proveedor o al administrador del portfolio que libere el número y empieza de nuevo con el mismo enlace.",
  "3441069":
    "Este número está en la app normal de WhatsApp, no en la app WhatsApp Business. Pásalo a la app WhatsApp Business y empieza de nuevo con el mismo enlace.",
  "3441070": NOT_FROM_APP,
  "3441072": NOT_FROM_APP,
  "3441090":
    "Este número está en otra cuenta de WhatsApp Business de tu propio portfolio comercial. Quítalo de esa cuenta en el Administrador de WhatsApp y empieza de nuevo con el mismo enlace.",
  "3441071":
    "El portfolio comercial al que pertenece este número exige la autenticación en dos pasos en tu cuenta de Facebook. Actívala en la configuración de seguridad de Facebook y empieza de nuevo con el mismo enlace.",
  "3441075": "Este número tiene activada la verificación en dos pasos. Desactívala y empieza de nuevo con el mismo enlace.",
  "2655145":
    "Tu cuenta de Facebook tiene restringida la gestión de activos empresariales. Revisa la restricción en Business Support Home de Meta o pide a otra persona de tu negocio que abra este enlace.",
  "2655123": PAGE_LINKED,
  "2655082": PAGE_LINKED,
  "3441093":
    "Este número aún se está desconectando de una conexión anterior, lo que puede tardar desde unos minutos hasta más de un día. Empieza de nuevo con el mismo enlace más tarde.",
  "2494064":
    "Este número ya está registrado en otro servicio de WhatsApp, por ejemplo otro proveedor de la API de WhatsApp. Pide que lo liberen y empieza de nuevo con el mismo enlace.",
};

/** The connection-link landing page, in Spanish. */
export const es: ConnectLinkCopy = {
  lang: "es",
  pageTitle: "Conecta tu número de WhatsApp",
  summary: "Conecta el número que tu negocio usa en la app WhatsApp Business. Son unos 5 minutos.",
  loading: "Comprobando el enlace…",
  title: (workspace) => `Conecta tu número de WhatsApp a ${workspace}`,
  intro: (inviter) =>
    `${inviter} te ha pedido que conectes el número que tu negocio usa en la app WhatsApp Business. Seguirás usando la app en tu teléfono como siempre.`,
  beforeTitle: "Antes de empezar",
  before: ["Este ordenador y el teléfono, los dos a mano", "Una cuenta de Facebook (vale la tuya personal)", "Unos 5 minutos"],
  meta: "Meta abrirá una ventana, te pedirá que inicies sesión y mostrará un código QR para escanearlo con el teléfono. Tu número y tu cuenta de empresa de Meta siguen siendo tuyos.",
  release:
    "¿Has usado este número con otro proveedor de la API de WhatsApp o en otro portfolio comercial? Pide que lo liberen antes de empezar.",
  button: "Conectar con Meta",
  preparing: "Preparando…",
  connecting: "Conectando…",
  connectedTitle: "Conectado.",
  connected: (phone, workspace) =>
    `${phone ?? "Tu número"} ya funciona con ${workspace}. No cambia nada en tu teléfono. Puedes cerrar esta página.`,
  leftOut: (inviter) =>
    `Algunos números se han quedado fuera: este espacio de trabajo no puede añadir números nuevos ahora mismo. Díselo a ${inviter}.`,
  pending: (inviter) =>
    `Tu cuenta de WhatsApp está conectada, pero el número aún no está listo. ${inviter} lo terminará. Puedes cerrar esta página.`,
  unknown: (inviter) =>
    `Estamos comprobando si tu número se ha conectado. ${inviter} te lo confirmará. No empieces de nuevo.`,
  busy: "Ya hay una conexión en curso con este enlace. Espera un minuto y empieza de nuevo.",
  notPrepared: "No se ha podido preparar la conexión. Cierra la ventana de Meta y empieza de nuevo.",
  cancelled: "No se ha conectado nada. Puedes empezar de nuevo con el mismo enlace.",
  signupErrors,
  reported: (code, session) => {
    const refs = [code && `error ${code}`, session && `sesión ${session}`].filter(Boolean);
    return `Meta indicó ${refs.join(", ")}. ${refs.length > 1 ? "Compártelos" : "Compártelo"} si pides ayuda.`;
  },
  gone: (inviter) => `Este enlace ya no funciona. Pide uno nuevo a ${inviter}.`,
  sender: "quien te lo envió",
  owned: (inviter) => `La cuenta de Meta de este número ya está conectada en otro sitio. Díselo a ${inviter}.`,
  noWaba: "Meta no ha compartido ninguna cuenta de WhatsApp. Empieza de nuevo y completa todos los pasos en la ventana de Meta.",
  closed: (inviter) => `Este espacio de trabajo no puede añadir números ahora mismo. Díselo a ${inviter}.`,
  failed: "No se ha podido completar la conexión. Empieza de nuevo con el mismo enlace.",
  attemptExpired: "Ese intento ha tardado demasiado. Empieza de nuevo con el mismo enlace.",
  popupBlocked: (host) =>
    `Tu navegador ha bloqueado la ventana de Meta. Permite las ventanas emergentes para ${host} y vuelve a pulsar.`,
  closeMeta: "Cierra la ventana de Meta y vuelve a intentarlo.",
  scriptBlocked: "No se ha cargado el script de Meta. Desactiva cualquier bloqueador en esta página y recárgala.",
  unavailable: (inviter) => `La conexión no está disponible ahora mismo. Díselo a ${inviter}.`,
  limited: "Demasiados intentos. Espera unos minutos y vuelve a abrir el enlace.",
  unreachable: "No se ha podido contactar con Eccos. Revisa tu conexión y recarga la página.",
};
