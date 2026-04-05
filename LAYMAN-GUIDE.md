# AI Audit Ledger — How the pieces fit together (plain English)

This page explains **what each part does** and **how they connect**, without assuming cloud or programming background. For diagrams and file locations, see [SETUP-AND-ARCHITECTURE.md](./SETUP-AND-ARCHITECTURE.md). For deployment steps, see [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## The idea in one sentence

You want a **trusted record** of "the AI made this decision, at this time, with this model," without storing people's raw CVs or names in your cloud. This system **accepts those records quickly**, **stores them so they cannot be altered**, and lets **your team read them back** for audits.

---

## The two "lanes" of traffic

1. **Sending data in (ingest)** — A customer's software says: "here's a new AI decision event."
2. **Reading data out (read)** — Your compliance team or dashboard says: "show me recent events" or "prove this record hasn't been altered."

Those use **different passwords** (API keys): one for **customers who send**, one for **people who only read**.

---

## How the "sending" side fits together (step by step)

### 1. Customer's app + SDK (on their side)

They do not send the full resume or name in plain text if they follow the design: they **hash** that stuff on their own computers and only send **fingerprints** (hashes) plus things like model name and decision JSON.

**Plain English:** They prepare a **summary package** that proves *what went in* without keeping your copy of the raw document.

### 2. API Gateway

This is the **public front door** on the internet: one stable web address for "POST here to log an event."

**Plain English:** The **reception desk** that receives HTTPS requests and routes them to the right internal handler.

### 3. Ingest Lambda ("the bouncer + intake form")

It checks: Is the **password** (API key) allowed? Is the **JSON** shaped correctly? It does **not** slowly write to the big database here. It **drops a message in a queue** and answers **"got it" (202)** right away.

**Plain English:** **Quick check-in** — "You're allowed in, your form is valid, we've put your ticket in the tray; you can go."

### 4. SQS queue ("the tray / waiting line")

A holding area for work. If many customers send data at once, the line absorbs the spike so the **intake** never has to wait for the slow part.

**Plain English:** **Inbox tray** so the "fast yes" never blocks on "heavy filing."

### 5. Processor Lambda ("the clerk who files papers")

It picks up items from the tray and **writes them into two places**: the searchable index (DynamoDB) and the permanent vault (S3).

**Plain English:** **Back office** — does the actual **filing** after the customer already left the counter.

### 6. DynamoDB ("the searchable index")

A fast database used to **list and search** records — filter by date, look up by customer, find a specific event ID.

**Plain English:** The **filing cabinet index** — organised so you can find what you need quickly.

### 7. S3 Object Lock ("the permanent sealed vault")

Every record is also written here as a file that is **physically locked** — it cannot be edited or deleted for 7 years, not even by the account owner. This is the same technology banks and financial institutions use for regulatory record-keeping.

**Plain English:** The **sealed evidence box** — once filed, it cannot be touched. This is your proof to a regulator that records have not been quietly altered.

### 8. Dead-letter queue (DLQ) ("the problem bin")

If something keeps failing when filing, the message lands here so **ops** can see what broke instead of losing it silently.

**Plain English:** **Broken letters pile** for investigation.

---

## How the "reading" side fits together

### 9. Read Lambda ("the librarian")

When someone calls **GET** (with the **read** key), this code:
- **Lists events** from DynamoDB (fast, filterable)
- For a **tamper-evidence check**: fetches both the DynamoDB record and the original locked S3 copy, compares them, and reports whether they match

**Plain English:** **Read-only access** to the records. The tamper check is like asking "does the filing cabinet card match the sealed original?" — any discrepancy is flagged immediately.

---

## How it all fits as a story

- **Customer** → **Front door** (API Gateway) → **Quick intake** (ingest Lambda) → **Tray** (queue) → **Filing** (processor) → **Index** (DynamoDB) + **Vault** (S3).
- **Your team** → **Same front door** (API Gateway) → **Librarian** (read Lambda) → **Index** (DynamoDB) + **Vault** (S3).

The **queue** is the reason **"accept" can be fast** while **"permanent storage"** can take a moment without blocking the customer's system.

---

## Quick "what does X do?" cheat sheet

| Piece | Layman's job |
|--------|----------------|
| **SDK** | Hash sensitive stuff locally; send only safe summary + decision info. |
| **API Gateway** | Public HTTPS address; routes traffic to the right function. |
| **Ingest Lambda** | Validate key + payload; enqueue; return **202** fast. |
| **Queue (SQS)** | Buffer so spikes don't overwhelm filing. |
| **Processor Lambda** | Take from queue; write each event to DynamoDB and S3. |
| **DynamoDB** | Fast searchable index for listing and filtering records. |
| **S3 Object Lock** | Permanent sealed vault — records locked for 7 years, cannot be altered. |
| **Read Lambda** | Read-only queries for lists and per-event tamper-evidence checks. |
| **DLQ** | Hold messages that failed repeatedly so you can fix issues. |
