# Divine Glorious Enterprises - Receipt App

React + Firebase receipt generator with real-time totals, downloadable PDF receipts, and live sales analytics.

## Features

- Company branding: **Divine Glorious Enterprises**
- Firebase Authentication (email/password login + registration)
- Add multiple products per receipt (product name, amount, qty)
- Real-time total calculation while typing
- One-click PDF receipt download
- Firebase Firestore persistence for each sale (scoped per signed-in user)
- Sales dashboard totals for:
  - Today
  - This week
  - This month
  - Last month
  - Last 3 months (excluding current month)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file from template:

```bash
copy .env.example .env
```

3. Fill in your Firebase project values in `.env`.

4. In Firebase Console, enable Authentication:

- Authentication -> Sign-in method -> Email/Password -> Enable
- Authentication -> Sign-in method -> Google -> Enable

5. Start the dev server:

```bash
npm run dev
```

## Firestore

Use a `sales` collection. The app writes these fields for each receipt:

- `companyName`
- `receiptNumber`
- `items` (array of product rows)
- `total`
- `createdAt` (server timestamp)
- `createdAtMs` (client timestamp used for sorting and analytics)
- `createdByUid`
- `createdByEmail`

Deploy the included secure Firestore rules so each user can only access their own sales:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /sales/{saleId} {
      allow create: if request.auth != null && request.resource.data.createdByUid == request.auth.uid;
      allow read, update, delete: if request.auth != null && resource.data.createdByUid == request.auth.uid;
    }
  }
}
```
