# PrintPortal on Render and Turso

This fork retains attribution to sh1vam-03/printportal. The upstream README declares MIT, but no LICENSE file was supplied; clarify licensing with the author before redistribution.

## Services
Use render.yaml or create a Node web service (server) and a static site (client). Node 22.16.0. Backend: npm ci, npm start. Frontend: npm ci && npm run build, publish dist, rewrite /* to /index.html.

Backend variables: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, JWT_SECRET (32+ random characters), JWT_EXPIRES_IN=15m, CLIENT_ORIGIN (frontend HTTPS URL), ALLOW_SIGNUP=false. Frontend variables: VITE_API_URL (backend HTTPS URL plus /api), VITE_SOCKET_URL (backend HTTPS URL). Never commit .env or tokens.

Temporarily enable ALLOW_SIGNUP only during owner onboarding, then disable it. Owner chooses their password in the website. No default login credentials are shipped.

## Storage
Dedicated Turso database; tables and indexes initialize automatically. PDFs, JPEG/PNG/WebP, text and DOCX up to 5 MB are stored as private database blobs and streamed only after authorization. No Cloudinary credentials required. Store only customer-authorized documents. This is a printing workflow application, not a government-data retrieval service. Database file storage consumes the Turso account's shared storage and request quotas. Keep backups and define retention before real customer use.

## Security changes
Organization checks on user deletion/session termination, authenticated Socket.IO rooms, 15-minute JWTs, minimum 12-character account passwords, auth rate limits, security headers, upload size limits, private authenticated file delivery, no password logging. Public organization signup disabled by default. Printing staff can access approved/in-progress/completed requests only.

## Verification
Run npm test in server. Integration test covers owner signup, employee login, tenant isolation for user deletion/session termination and files, upload/download bytes, approval, dashboard stats and session revocation. Run npm run build in client. These tests do not constitute a comprehensive security audit.
