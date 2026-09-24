# TutorConnect Backend

Node.js API for TutorConnect. Firebase Authentication remains the identity provider; this API verifies Firebase ID tokens and uses Firebase Admin SDK for trusted server-side operations.

## Setup

1. Copy `.env.example` to `.env`.
2. Create a Firebase service account in Firebase Console and fill the three Firebase variables.
3. Install dependencies with `npm install`.
4. Run `npm run dev`.

The service starts on `http://localhost:3000`.

For a phone demo without a laptop, see [DEPLOY_RENDER.md](DEPLOY_RENDER.md). Deployment requires your hosting account and a real HTTPS URL before building the standalone APK.

ZaloPay sandbox payments (default): see [ZALOPAY_SANDBOX.md](ZALOPAY_SANDBOX.md) for merchant credentials, physical-device setup and the test flow. The optional MoMo adapter remains documented in [MOMO_SANDBOX.md](MOMO_SANDBOX.md).

## Endpoints

- `GET /health` - API health check.
- `GET /api/me` - returns the authenticated Firebase user and Firestore profile. Requires `Authorization: Bearer <Firebase ID token>`.

Never put the Firebase Admin private key in the mobile app or commit it to git.
