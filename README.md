# Scaler AI Sales Copilot

## 1. What I built
A lightweight full-stack sales copilot for the Scaler take-home. The app asks for the BDA/evaluator WhatsApp number, accepts arbitrary lead profiles plus either a transcript or audio file, sends a short pre-call WhatsApp nudge to the BDA, extracts post-call insights, generates a grounded and visibly personalized PDF preview, and routes every lead-facing outbound through a clear `Approve / Edit / Skip` gate before delivery. The implementation uses a curated Scaler evidence pack from official `scaler.com` pages, Deepgram for voice-to-text, OpenRouter with free models for extraction and generation when configured, deterministic fallbacks when they are not, direct PDF generation, and Twilio WhatsApp delivery or simulated sends in local mode.

## 2. One failure I found
When no `DEEPGRAM_API_KEY` is configured and the user uploads audio without a transcript, the fallback transcription is intentionally generic, so downstream personalization loses nuance. I kept that failure visible instead of hiding it because pretending the transcript is precise would create false confidence in the generated PDF.

## 3. Scale plan
At `100,000` leads per month, the first two things to break are grounding quality and human review throughput. Grounding breaks because a small curated evidence pack drifts as Scaler updates programs, outcomes, and messaging; it needs scheduled refresh plus claim-level versioning. Review throughput breaks because lead-facing sends are approval-gated, so BDAs become the bottleneck; the product needs batching, draft ranking, and exception-based review instead of forcing identical manual effort on every lead.

## Local setup
1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Optionally add `OPENROUTER_API_KEY`, `DEEPGRAM_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, and a deployed `PUBLIC_BASE_URL`.
4. Run `npm run dev`.
5. Open [http://localhost:3000](http://localhost:3000).
6. Run `npm run test:live` to generate real local sample outputs without sending WhatsApp messages.

## Environment variables
- `PORT`: local server port, defaults to `3000`
- `PUBLIC_BASE_URL`: required for Twilio media sends because WhatsApp needs a public PDF URL
- `OPENROUTER_API_KEY`: enables LLM-based extraction and generation
- `OPENROUTER_EXTRACTION_MODEL`: defaults to `openrouter/free`
- `OPENROUTER_GENERATION_MODEL`: defaults to `openrouter/free`
- `DEEPGRAM_API_KEY`: enables real audio transcription for uploaded recordings
- `DEEPGRAM_MODEL`: defaults to `nova-3`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`: enable real WhatsApp delivery

## API surface
- `POST /api/generate-precall`
- `POST /api/generate-postcall`
- `POST /api/approve-send`
- `GET /assets/:assetId.pdf`

## Notes
- The app is intentionally lean: no auth, CRM sync, database, or long-term storage.
- If Twilio is not configured, sends are simulated but the exact message bodies and PDF previews are still generated.
- If Deepgram is not configured, audio transcription falls back to a clearly labeled placeholder so the rest of the demo can still run.
- If OpenRouter is not configured, transcript insight extraction and PDF personalization fall back to deterministic heuristics so the demo flow still works end to end.
- The server auto-loads `.env` locally, so `npm run dev` and `npm start` will pick up your configured keys.
