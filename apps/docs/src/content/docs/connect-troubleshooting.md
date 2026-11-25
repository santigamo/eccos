---
title: "Connecting a number: troubleshooting"
description: "Fix the errors Meta shows when you connect a WhatsApp Business app number to Eccos (coexistence): #2655122, #3441060, #2655123, the QR code step, an expired attempt and a number that is greyed out."
---

This page is for numbers you connect with **"I use this number in the WhatsApp Business app"**
on the console's **Numbers** page. Each section is named after the message or error code Meta
shows in its window, so you can match it to your screen.

## How coexistence works

With coexistence your number keeps working in the WhatsApp Business app on your phone while Eccos
uses the same number through Meta's Cloud API. To allow that, Meta requires that the number is not
tied to any other Meta product: another WhatsApp Business account (such as a developer test app),
the Meta AI agent in the app, or a Facebook Page. Meta reports **one blocker at a time**. When you
fix one and try again, the next one can appear. That is expected: each fix removes one tie, and
the connection goes through once none are left.

## Quick answers

- **Meta says "Not eligible" or #2655122.** The number sits, unverified, in another WhatsApp
  Business account, often your own developer test app. Unlink it there, then type the number by
  hand in Meta's window.
- **Meta says #3441060, "connected to Meta Business Agent".** The Meta AI agent is on in your
  WhatsApp Business app. It cannot run together with Eccos, so turn it off in the app if you want
  Eccos.
- **Meta says #2655123, "already connected to a Facebook Page".** Unlink the Page from the number.
  Your chats stay; the Page's WhatsApp button and ads that open WhatsApp stop working.
- **I fixed one error and got another.** Normal: Meta shows one blocker at a time. Fix the new one
  and start again.
- **Will my WhatsApp Business app keep working?** Yes. Coexistence keeps the app working on your
  phone. Do not delete anything on the phone.
- **The QR code does not scan.** Choose **"Use an access code instead"** on the same screen.
- **The console says "That connection attempt expired before Meta answered".** Start again from
  the Numbers page and go through Meta's window in one go.
- **Messages stopped reaching Eccos after I linked the number to a Facebook Page.** Remove Eccos as
  a partner in your Business Settings, wait a few minutes, then connect again from the Numbers
  page.
- **My number is new to the WhatsApp Business app.** Meta usually wants about a week of real use in
  the app before it allows coexistence.

## "Not eligible: can't be shared with the app" (#2655122)

**What it means.** The number is greyed out in Meta's list of numbers. It has been added,
unverified, to another WhatsApp Business account in your business portfolio, usually the one
behind a developer test app you created in Meta for Developers. While it sits there, Meta will not
share it with Eccos.

**What you lose.** Nothing. You only remove an unfinished copy of the number from the other
account. Do not delete test numbers, and do not delete anything in the WhatsApp Business app on
your phone.

**Fix it:**

1. Open Meta [Business Settings](https://business.facebook.com/settings) for your business
   portfolio.
2. Go to **Accounts**, then **WhatsApp accounts**, and open the account that holds the unverified
   copy of your number (not the one named after your business that you use every day).
3. Open the **Linked WhatsApp accounts** tab.
4. On the row with your number (marked as not verified), open the **⋯** menu and choose
   **Unlink**.
5. Check that the tab no longer lists your number.

**Retry.** In the Eccos console, open **Numbers**, press **+ Add number**, and choose **"I use this
number in the WhatsApp Business app"**. When Meta asks for the number, choose **"Add a new phone
number"** and type it by hand instead of picking it from the list.

## "Connected to Meta Business Agent" (#3441060)

**What it means.** The Meta AI agent (Meta Business Agent) is switched on in your WhatsApp
Business app. Meta does not let it run together with an API connection such as Eccos, so you have
to choose one of them.

**What you lose.** The Meta AI agent and its settings. Your chats and the app itself stay.

**Fix it, in the WhatsApp Business app on your phone:**

1. Open **Tools**, then **Meta Business Agent**. It is under Tools, not under Settings.
2. Open **Response settings**.
3. Tap **Disconnect AI**. On iPhone the option is called **Delete your AI agent**.
4. Confirm with **Disconnect and delete my AI**.

Meta's own guide: [turn off the AI agent in WhatsApp Business](https://faq.whatsapp.com/1326310392254030).

**Retry.** Start again from **Numbers** with **"I use this number in the WhatsApp Business app"**.

## "Already connected to a Facebook Page" (#2655123)

**What it means.** The number is linked to a Facebook Page as that Page's WhatsApp number. Meta
will not connect it to Eccos while that link exists.

**What you lose.** The WhatsApp button on the Facebook Page, and ads that open a WhatsApp chat
with this number. Your WhatsApp chats and contacts stay.

**Fix it:**

1. Use the link in Meta's error message to unlink your account, if it shows one.
2. Otherwise, unlink it in the WhatsApp Business app: **Settings**, then **Business tools**, then
   **Facebook & Instagram**, then **Unlink**. You can also remove the Page in Meta Business Suite
   under **Settings**, **Accounts**, **Pages**.

**Alternatives** if you want to keep a WhatsApp button on the Page:

- link a different number to the Page, or
- put a `https://wa.me/<your number>` link on the Page instead (the number in international
  format, digits only).

**Retry.** Start again from **Numbers** with **"I use this number in the WhatsApp Business app"**.

## Messages stopped after linking the number to a Facebook Page

**What it means.** After the number is connected to Eccos, linking it to a Facebook Page can break
Eccos's access to it without any error. Messages still reach your phone, but stop reaching Eccos
and your webhook. Unlinking the Page again does not restore the access on its own.

**Prevent it.** Once the number is connected to Eccos, do not link it to a Facebook Page. Use a
different number for the Page, or a `wa.me` link.

**Fix it:**

1. Open Meta [Business Settings](https://business.facebook.com/settings) for your business
   portfolio.
2. Go to **Users**, then **Partners**.
3. Select **Eccos** and remove it as a partner.
4. Wait about 5 minutes.
5. In the Eccos console, open **Numbers**, press **+ Add number**, and choose **"I use this number
   in the WhatsApp Business app"**. Go through Meta's window to the end.

Reconnect from the Eccos console, not by adding Eccos as a partner again by hand. Until you
reconnect, sending from Eccos stops too. Then send a test message to the number and check that it
appears in Eccos.

## The QR code on "Import contacts and chat history" doesn't scan

**What it means.** At this step Meta links the WhatsApp Business app on your phone to the
connection. Scanning the QR code sometimes fails.

**Fix it:**

1. On the same screen, choose **"Use an access code instead"**.
2. Enter the code in the WhatsApp Business app as Meta describes, and continue.

If Meta says at this step that the number does not have enough activity, see
[the number is new to the WhatsApp Business app](#the-number-is-new-to-the-whatsapp-business-app).

## "That connection attempt expired before Meta answered. Start it again."

**What it means.** This message comes from the Eccos console, not from Meta. Meta's window took
too long, so the console stopped waiting. Meta may already have finished its part, so nothing is
lost.

**Fix it:**

1. Open **Numbers**, press **+ Add number**, and choose the same option as before.
2. Go through Meta's window in one go, without long pauses. It is usually quick the second time,
   because the blockers are already fixed.

## Number greyed out or not listed in Meta's window

**What it means.** Meta's list of numbers only shows numbers it already knows in your portfolio,
and greys out the ones it will not share as they are. Your number can be missing or greyed out
even when it is ready to connect.

**Fix it:**

1. Choose **"Add a new phone number"**.
2. Type your number by hand and continue.

If Meta then shows an error code, find its section on this page. A greyed-out number with "Not
eligible" is covered in [#2655122](#not-eligible-cant-be-shared-with-the-app-2655122).

## The number is new to the WhatsApp Business app

**What it means.** Meta usually wants a number to have about a week of real use in the WhatsApp
Business app before it allows coexistence. This is what we see in practice, not a rule Meta
documents, and the exact time can vary.

**Fix it.** Keep using the number in the WhatsApp Business app for about a week (sending and
receiving real messages), then start again with **"I use this number in the WhatsApp Business
app"**.

## What to send support

If none of these sections matches, or a fix does not work, email Eccos support with:

1. A screenshot of the **whole** Meta window, including the error code (such as `#2655122`) and
   the **Session ID** shown at the bottom.
2. Which option you chose on the Numbers page, and the step where Meta stopped.
3. Any message the Eccos console showed afterwards. When Meta reports an error, the console
   shows a line such as `Meta error 2655123 · session …`; copy it as it is.

The Session ID lets Meta's support find your exact attempt.
