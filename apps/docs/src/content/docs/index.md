---
title: Eccos Cloud API
description: "Send WhatsApp messages over HTTP and receive incoming messages and delivery statuses on your own webhook with the Eccos Cloud API."
---

Integration guide for Eccos Cloud: send WhatsApp messages over HTTP and receive incoming
messages and delivery statuses on your own webhook. Eccos is a thin layer over the official
Meta WhatsApp Cloud API, so message bodies are Meta's own format
([message reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages)).

- API base URL: `https://api.eccos.chat`
- Console: `https://app.eccos.chat`

## Getting started

1. Sign up at `app.eccos.chat`.
2. **Numbers**: connect a WhatsApp number with Meta Embedded Signup. Choose **"I use this number
   in the WhatsApp Business app"** to keep using the app on your phone alongside the API
   (coexistence), or **"A new number, or one not on WhatsApp"**. The second option takes a number
   that is on WhatsApp today off the app. The Numbers page then lists each number with its
   **Phone number ID** and **WABA** (WhatsApp Business Account) id. You need the WABA id in every
   API call.
3. **Settings**, **API keys**: enter a label and press **Create key**. The key (prefix `ek_`) is
   shown once; store it. You can revoke it from the same list.
4. **Webhooks**, **Forwarding target**: set the **Forwarding URL** (HTTPS) and a **Signing secret**
   (type one or press **Generate**), then **Save**. The secret is write-only: the console never
   shows it again, so keep your own copy. See [Webhooks](/webhooks).
