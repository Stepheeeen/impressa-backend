# Impressa Postman Collection

This folder contains a Postman collection and environment for the Impressa backend API.

Files:
- `Impressa.postman_collection.json` — Postman collection (v2.1) covering Auth, Templates, Designs, Orders, and Admin endpoints.
- `Impressa.postman_environment.json` — Environment with `{{base_url}}` and `{{authToken}}` variables.

Quick start
1. Start the Impressa backend locally (defaults to `http://localhost:5000`).
2. In Postman, import `Impressa.postman_collection.json` (File > Import).
3. Import the environment `Impressa.postman_environment.json`.
4. Select the `Impressa Local` environment in Postman.
5. Use the `Auth -> Register` request to create a user, then `Auth -> Login` to obtain a token.
6. Copy the token (from the login response) into the `authToken` environment variable (without the `Bearer ` prefix — collection uses `Bearer {{authToken}}`).

Notes and tips
- Protected endpoints include an `Authorization: Bearer {{authToken}}` header. Set `{{authToken}}` after login.
- Path parameters like `:id` are represented as Postman variables in the collection; replace `<designId>` / `<orderId>` with actual IDs returned from create endpoints.
- The collection includes reasonable example JSON bodies you can modify.

If you want, I can also:
- Add example tests to the collection (for common assertions).
- Add a small Newman script and package.json entry to run the collection from CI.
