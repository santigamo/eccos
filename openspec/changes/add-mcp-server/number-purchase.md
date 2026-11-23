# Obtaining new numbers: options

Researched on 2026-11-23 from Meta's, the carriers' and the regulator's own pages. This is a
decision for the owner; the recommendation is at the end. "Not verified" marks what no primary
source settled.

## What is true today

- Eccos does not sell numbers. Customers bring a number through Embedded Signup. The site says
  Eccos "is not a Solution Partner (BSP) and does not resell messages".
- **Meta does not sell production numbers.** It generates one test number per app.
- **The Meta side is automatable once a WABA is connected.** Four Graph calls register a number:
  create it on the WABA (`POST /{waba}/phone_numbers`), `request_code` (SMS or voice),
  `verify_code`, `register` with a six-digit PIN. Embedded Signup is not required for these.
  <https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/registering-phone-numbers>
- **Meta's requirements**: the number must "be owned by you", receive voice calls or SMS, and not
  already be on WhatsApp. A new, unverified business portfolio is capped at two registered
  numbers. Display names are reviewed and can be rejected.
  <https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers>
- **Spanish fixed numbers verify by voice.** Meta rates SMS to fixed lines "Not Recommended" and
  voice "Standard". netelip, a Spanish carrier, states that verification on its numbers is "SIEMPRE
  por llamada, nunca por SMS". Twilio lists Spain among numbers with "mixed" WhatsApp activation
  success, as a private offering. <https://help.twilio.com/articles/360026678054>
- **Every carrier that sells +34 numbers requires the holder's documents**: identity (DNI, NIE or
  company registration and CIF) and proof of a Spanish address, for geographic numbers an address
  in the number's area. Review takes about three business days (Twilio) or 72 hours (Telnyx).
  Telnyx also requires the end user to be physically in Spain. The data can be submitted by API
  (Twilio Regulatory Bundles, Telnyx Requirement Groups, DIDWW, netelip API Cloud); the documents
  themselves come from a person.
  <https://www.twilio.com/en-us/guidelines/es/regulatory>,
  <https://support.telnyx.com/en/articles/1311073-spain-did-requirements>
- **Pre-verified numbers** are a Meta feature for Tech Providers: Eccos verifies numbers in its
  own portfolio in advance, and a customer claims one inside Embedded Signup with no code to
  exchange. Unclaimed numbers expire after 90 days. Eccos is a Tech Provider. Whether the feature
  works with Embedded Signup v4, which Eccos uses, is not verified; Meta's samples show v2.
  <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/pre-verified-numbers>

## How a code would reach an agent

1. The carrier number is configured with a webhook for inbound calls (and SMS where the number
   type supports it).
2. The gateway calls `request_code` with `VOICE`.
3. The carrier answers, records and transcribes. Meta's call says "Verification code is ..." three
   times, which allows a two-out-of-three check on the digits.
4. The gateway matches the code to the pending number, calls `verify_code`, then `register`.

This is a small state machine in the control plane (requested, received, verified, registered),
driven by alarms, with a timeout and a fallback where the person types the code. The weak points
are transcription errors, numbers behind an IVR or call forwarding (Meta and Twilio both say
these cannot receive the code), and an undocumented lock-out after repeated `request_code` calls.
Recordings are deleted after use and the code is never logged or returned to the agent.

## Options

| | Option | What the agent does | Human steps left | Cost to Eccos | Regulatory burden | Effort |
|---|---|---|---|---|---|---|
| A | **A number the customer already owns** | Adds it to the WABA, asks Meta to call or text, takes the code from the person, registers it, explains the two-number cap and name review | Embedded Signup once; reading out one code per number | None | None | Low: the phase 3 Graph calls |
| B | **The customer's own carrier account** (keys stored in Eccos) | Searches and buys a number, captures the code from the carrier, registers it | Embedded Signup; opening the carrier account; **the customer's identity and address documents, once**, then about three days | None; the customer pays the carrier | Low: the customer is the holder. Eccos stores a third party's credentials | Medium: one adapter per carrier, a credential store, webhook receivers, transcription |
| C | **Eccos holds the numbers** and pre-verifies them with Meta | Offers a number; the customer claims it in Embedded Signup | **Embedded Signup only** | Rental from purchase until release, roughly 2 to 5.50 USD a month per number at the prices found, plus a second billing line | High and unsettled (below) | High: a number pool, expiry jobs, billing, release and port-out, abuse controls |
| D | **A carrier partnership** where the carrier remains the legal operator and holder | As C or B, depending on the agreement | Embedded Signup plus whatever the carrier requires | A revenue share or referral | Medium: the carrier carries the numbering duties | Medium, plus a commercial negotiation |
| E | **Non-Spanish numbers** with light requirements | Buys and registers | Embedded Signup only | Low | Low | Low |

E is listed for completeness. A Spanish small business with a foreign number loses the local
trust it is buying WhatsApp for.

## What is unsettled about C

- **Whether Eccos would have to notify the CNMC as an operator.** Ley 11/2022 art. 6.2 requires
  prior notification for providing electronic communications services to the public, and
  numbering is assigned to operators, who may sub-assign it. No CNMC resolution found addresses a
  SaaS that rents numbers through a carrier account and lets customers use them. This needs a
  lawyer or a formal consultation. <https://www.cnmc.es/sectores-que-regulamos/telecomunicaciones/registro-de-operadores>
- **Carrier terms.** Carrier documentation frames the documented holder as the party using the
  number (Bandwidth's Spain requirements address customers "not further assigning these services
  to other parties"). Resale terms were not read for any carrier.
- **Meta's "owned by you".** Pre-verified numbers are the documented route for a Tech Provider;
  how Meta treats numbers a Tech Provider holds outside that feature is not verified.
- **Billing.** Today's plan is one Creem product priced per connected number: 5 EUR for the
  first, 3 EUR for each of numbers two to five. A carrier number at 5.50 USD costs more than that
  increment, so rental needs its own line, and whether Creem, as merchant of record, accepts
  selling number rental is not verified. Number rental also keeps costing after a subscription
  ends, so cancellation needs a release or port-out policy, and the chat history belongs to the
  number.
- **Positioning.** It would be the first third-party cost Eccos resells.

## Recommendation

**A now, B next, C only after the questions above have written answers.**

- **A** is phase 3 of this change. It carries no regulatory or billing weight, it is the
  foundation the other options need anyway, and it already removes most of the manual work: the
  only thing left for the person is reading out a code.
- **B** gives the "agent buys a number" experience without Eccos holding numbers, contracts or
  identity documents. The one step it cannot remove is the customer's own documents, which no
  option removes for a Spanish number the customer holds. Start with one Spanish carrier that
  documents WhatsApp verification by call and has an API for purchase, requirements and
  transcription (netelip), and one with a strong general API (Telnyx).
- **C** is the only option that reaches "Embedded Signup is the only human step". Before building
  it: a written opinion on CNMC notification; a carrier's resale terms in writing; Creem's answer
  on number rental; a test of pre-verified numbers with Embedded Signup v4; and a price that
  covers rental.

What would change this: a carrier willing to be the legal holder for Eccos's customers (D) moves
the regulatory burden off Eccos and makes C's experience reachable at B's risk.

## Not verified

Prices and inbound-SMS behaviour for Spanish numbers at most carriers; availability of Spanish
mobile numbers by API; whether the stored Embedded Signup token may add and register numbers;
Meta's limits on `request_code`; IVA treatment of number rental.
