# PORS Web Quote Data Contract

## 1. Ownership Boundary

- Noblesse owns Buyer accounts, Inquiry List, Request Quote, quote lines, and quote workflow state.
- PORS owns tablet sales entry, local sales history, receipt printing, and receipt snapshots.
- PORS reads and updates web quotes only through the scoped Noblesse PORS API.
- Noblesse must not edit PORS sales records directly.
- PORS must not render or modify Noblesse website routes or buyer-facing UI.

## 2. Authentication And Configuration

- `PORS_NOBLESSE_API_BASE_URL` is the Noblesse API base URL.
- `PORS_NOBLESSE_READ_TOKEN` is required to read the web-quote list and detail.
- `PORS_NOBLESSE_WRITE_TOKEN` enables prepare, price preview, internal finalization, customer publication, and manual receipt linking without a separate Noblesse/Firebase login.
- The write token is a managed-device credential: it is accepted only by `/api/pors/quotes/*`, cannot call Noblesse admin or Buyer routes, and must be provisioned only to managed PORS devices. Rotate it when a device is lost or replaced.
- Firebase service accounts, PostgreSQL credentials, and private server keys must never be embedded in the app.

## 3. Read Contract

### List quotes

`GET /pors/quotes`

The request sends `X-Pors-Quote-Read-Token`.

The response contains `quotes` or `items`. Each list row may include:

- `id`
- `quoteNumber` or `inquiryNumber`
- `companyName` or `buyerCompany`
- `status` or `adminStatus`
- `itemCount`
- `requestedTotal` or `confirmedTotal`
- `pos.state` and `pos.pricing`

### Read quote detail

`GET /pors/quotes/:quoteId`

The response contains `quote` and optional `pos`. Quote lines may include:

- `id`
- `productCode`
- `productName`
- `imageSet` or `productImageUrl`
- `selectedOptions`
- `requestedQuantity`
- `confirmedQuantity`
- `confirmedUnitPrice`
- `cancellationReason`
- `cancellationNote`
- `itemNote`

## 4. Write Contract

All writes include `expectedVersion` and a unique `idempotencyKey`.

- `PUT /pors/quotes/:quoteId/picking` saves prepared quantities and cancellation details.
- `POST /pors/quotes/:quoteId/price-preview` requests a server-calculated preview.
- `POST /pors/quotes/:quoteId/finalize` finalizes internal quote pricing.
- `POST /pors/quotes/:quoteId/publish` publishes the finalized quote to the Buyer.
- `POST /pors/quotes/:quoteId/receipt-link` links an existing PORS receipt snapshot.

Each write sends `X-Pors-Quote-Write-Token`; a read token cannot be used for a write.

Picking line payload:

```json
{
  "id": "quote-line-id",
  "preparedQuantity": 10,
  "cancellationReason": "",
  "cancellationNote": "",
  "itemNote": ""
}
```

Receipt link payload contains only a snapshot and does not allow Noblesse to mutate the PORS sale:

```json
{
  "receiptId": "pors-sale-id",
  "receiptSnapshot": {
    "saleId": "pors-sale-id",
    "customerName": "customer label",
    "createdAt": "timestamp",
    "supplyAmount": 10000,
    "vatAmount": 1000,
    "totalAmount": 11000,
    "lineCount": 3
  }
}
```

## 5. Conflict And Offline Rules

- HTTP `409` means another device changed the quote; the app reloads the latest quote and requires review before another write.
- A partially prepared line requires a cancellation reason.
- Offline mode may show the last cached list/detail but must disable saves, price calculation, finalization, publication, and receipt linking.
- Quote cache keys are app-local display caches and are not a source of truth.

## 6. Pricing And Sales Rules

- The Noblesse server calculates web quote pricing.
- Web quote processing does not use the PORS threshold discount, customer discount, deduction, or group-purchase calculation.
- Finalizing or publishing a web quote does not create a PORS sale.
- A PORS sale enters local sales history only through the existing PORS save flow.
- Linking a receipt records a read-only receipt snapshot on the quote.
