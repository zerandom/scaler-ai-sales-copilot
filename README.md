# Scaler Sales Copilot

### What I built
I built an internal sales copilot that turns raw discovery calls into highly personalized, production-ready PDF career plans. Instead of BDAs manually writing follow-ups, the app takes a lead's profile and call transcript, extracts their real objections and goals, and uses an LLM to assemble a tailored 6-slide deck. It's deployed entirely on Vercel serverless functions, programmatically drawing the PDFs using `pdf-lib` and queuing them for BDA approval before pushing to WhatsApp.

### One failure I found
**Input**: A transcript where the lead just stated "I can't afford the 3.5L fee" without asking anything.
**Output**: The LLM returned empty arrays for `implicit_questions` and `evidence_gaps`.
**Why**: The extraction prompt was too rigid. It looked for literal question marks rather than translating emotional objections into structured concerns, resulting in blank PDF cards.

### Challenge
The biggest challenge and probably the most crucial piece of this work has been to get the AI to stick to creating different but Scaler worthy intricate PDFs; Rate Limits were challenging while solving for this

### Scale plan
If we scale to 100,000 leads a month, the synchronous approval gate breaks first. Right now, a BDA has to sit and wait 8 seconds staring at a loader while the AI thinks and the PDF generates before they can move to the next lead. At scale, this idle time costs thousands of sales hours. 

To fix this, we must shift to an asynchronous queue. The BDA drops the transcript, moves to their next call, and the finalized PDF simply arrives in a "Ready for Review" inbox later. We remove the BDA as the bottleneck.
