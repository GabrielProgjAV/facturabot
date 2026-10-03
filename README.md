# facturabot

**🌐 Language:** English · [Español](README.es.md)

> Electronic invoicing for small businesses in Colombia, straight from WhatsApp:
> send a photo of a handwritten invoice, review the draft, approve it.

⚠️ **Status: early development.** Not ready for production use yet.

## 1. Overview

Many small shops in Colombia still write invoices on paper, even though the law requires electronic
invoices validated by the DIAN (the national tax authority). Today, every time a customer asks for
one, someone has to manually type the customer's tax data (RUT) and the invoice into invoicing
software.

**facturabot** is a WhatsApp bot that automates this:

1. The shop owner sends the bot a **photo** of the handwritten invoice (or a **text**, or a
   **voice note**).
2. An AI model extracts the data: customer, line items and total.
3. The bot looks the customer up in the invoicing software and, if they don't exist, **asks in the
   chat** for the missing data and creates them.
4. The bot shows a **draft** (subtotal, VAT and total). The owner **approves** it or **corrects it in
   plain language** ("the paint is 3 gallons, not 2").
5. Only after approval is the electronic invoice issued through a **DIAN-authorized provider**
   (Alegra, later Siigo), and the PDF is sent back over WhatsApp.

Also planned: creating customers without invoicing, credit notes and reports ("how much did I sell
this week?").

**Pilot:** a small paint store.

## 2. Roadmap

| Phase | Description | Status |
|---|---|---|
| 0 | No-code validation (photos, AI, Alegra, Meta) | 🟡 In progress |
| 1 | Project foundation (NestJS, Docker, config, database) | 🟡 In progress |
| 2 | WhatsApp echo bot | ⚪ Pending |
| 3 | Reading photos with AI | ⚪ Pending |
| 4 | Alegra integration | ⚪ Pending |
| 5 | Conversational flow (draft → correction → approval) | ⚪ Pending |
| 6 | Invoice issuing | ⚪ Pending |
| 7 | Customers without invoice, credit notes | ⚪ Pending |
| 8 | Reports | ⚪ Pending |
| 9 | Siigo adapter | ⚪ Pending |
| 10 | Multi-tenant + web dashboard | ⚪ Pending |

## 3. Architecture decisions

| Decision | Choice | Why | Alternative considered |
|---|---|---|---|
| Channel | WhatsApp Business Cloud API (dedicated bot number) | Official and stable; unofficial libraries risk the number being banned | Baileys / whatsapp-web.js |
| DIAN issuing | Through a provider (Alegra → Siigo) | They handle DIAN certification, digital signatures and UBL 2.1 | Own DIAN integration (future) |
| Backend | TypeScript + NestJS | Modules + dependency injection; same language as the future web dashboard | Python + FastAPI, Kotlin + Spring |
| Database | PostgreSQL + Prisma | Relational, accounting-grade data; typed ORM | MySQL, TypeORM, Drizzle |
| Validation | Zod | Validates AI output and configuration, and generates types | class-validator |
| Queue | Redis + BullMQ | AI is slow; the webhook must answer fast | — |
| AI | Local (Ollama `qwen2.5vl:3b`), swappable for cloud models | Zero cost while testing | Gemini, Groq, OpenRouter |
| Architecture | Ports and adapters (`ProveedorFacturacion`, `LectorDeFacturas`, `Transcriptor`) | Switching provider or AI model is configuration, not a rewrite | Calling APIs directly |
| Principle | Human in the loop | Nothing is issued without explicit approval | — |
| Inputs | Photo, text and voice → one `BorradorFactura` (invoice draft) | Handwriting is hard to read; voice and text are more reliable fallbacks | Photo only |
| Speech-to-text | Whisper (local whisper.cpp) + FFmpeg | Free; WhatsApp sends `.ogg` audio | Groq API (cloud Whisper) |
| Calculations | Code recomputes totals; AI only extracts | If line items don't add up to the written total, something was misread and the bot asks | — |
| Invoice lines | **Simple mode** (default): 1 line, quantity 1, price = written total, using an existing generic product ("Pinturas varias"). Per-company **detailed mode** (catalog) | Prices vary by customer and over time, and many package sizes (gallon, 1/2, 1/4, 1/8) aren't in the catalog | Always use the detailed catalog |
| Line description | Whatever could be read ("Gallon of enamel, assorted colors") or the generic name | Clearer for the customer without flooding the catalog with one-off products | Create a new product per invoice |
| Item detail | Stored in our database (not sent to the provider) | Keep data for future reports and inventory | Discard it |
| VAT | The written total excludes VAT: it's sent as the base price with 19% VAT and the provider computes the tax. The draft shows subtotal, VAT and total | The approver sees the final amount before issuing | Compute VAT in code and send it pre-added |
| Personal data | Photos and customer data never go into git; handled per Colombia's Law 1581 of 2012 (data protection) | Legal obligation and trust | — |

> Domain names in the code (`BorradorFactura`, `ProveedorFacturacion`…) are in Spanish on purpose:
> they mirror the business language of the users.

## 4. Getting started

Requirements: [fnm](https://github.com/Schniz/fnm) (Node 24 per `.nvmrc`), [pnpm](https://pnpm.io)
and [Docker Desktop](https://www.docker.com/products/docker-desktop/) running.

```bash
docker compose up -d --wait   # PostgreSQL (localhost:5433) and Redis (localhost:6379)
fnm use                       # switch to the Node version in .nvmrc
cd apps/api
pnpm install
cp .env.example .env          # first time only; adjust values if needed
pnpm run start:dev            # server at http://localhost:3000 with hot reload
pnpm test                     # unit tests
```

To stop the infrastructure: `docker compose down` (keeps data). `docker compose down -v` also
**deletes** the data volumes.

A detailed development log (in Spanish) is available in [README.es.md](README.es.md#4-bitácora).

## 5. License

All rights reserved. The source code is publicly visible, but no license is granted to use, copy or
distribute it without the author's permission.
