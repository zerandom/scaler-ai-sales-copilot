# Scaler Sales Copilot

### What I built
I built an internal sales copilot that turns raw discovery calls into highly personalized, production-ready PDF career plans. Instead of BDAs manually writing follow-ups, the app takes a lead's profile and call transcript, extracts their real objections and goals, and uses an LLM to assemble a tailored 6-slide deck. It's deployed entirely on Vercel serverless functions, programmatically drawing the PDFs using `pdf-lib` and queuing them for BDA approval before pushing to WhatsApp.

### One failure I found
**Input**: A transcript where the lead just stated "I can't afford the 3.5L fee" without asking anything.
**Output**: The LLM returned empty arrays for `implicit_questions` and `evidence_gaps`.
**Why**: The extraction prompt was too rigid. It looked for literal question marks rather than translating emotional objections into structured concerns, resulting in blank PDF cards.

### Scale plan
If this scales to 100,000 leads a month, our Vercel serverless setup breaks first. Currently, waiting for the LLM to generate JSON and synchronously drawing coordinate-based PDFs via `pdf-lib` takes 5-8 seconds. At volume, we'll hit Vercel timeouts constantly. 

To fix this, I have to decouple the pipeline. I'd move the LLM generation to an async background worker (like Inngest) and replace the manual `pdf-lib` coordinate math with a dedicated HTML-to-PDF microservice using Headless Chromium. The frontend would just poll for completion.
