---
title: Authentication
description: "Authenticate Eccos Cloud API requests with an account API key sent as a Bearer token or X-API-Key header."
---

Send the account API key on every `/v1/*` request, either way:

```
Authorization: Bearer ek_...
X-API-Key: ek_...
```

If both are present, `Authorization: Bearer` is used (the word `Bearer` is case-sensitive). A missing, unknown or revoked key returns:

```
401 {"ok":false,"error":"unauthorized"}
```

A key belongs to your account and works for every WABA of that account. A WABA that is not yours
looks the same as one that does not exist (404).
