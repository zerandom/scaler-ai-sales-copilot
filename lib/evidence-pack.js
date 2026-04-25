export const scalerEvidencePack = [
  {
    id: "homepage-ai-integrated-curriculum",
    claim:
      "Scaler's homepage describes the curriculum as AI-integrated, with AI embedded in how learners frame, build, and ship work, and says the curriculum is updated quarterly.",
    sourceUrl: "https://www.scaler.com/",
    confidence: 0.91,
    tags: ["ai-curriculum", "currency", "program-design"],
  },
  {
    id: "homepage-genai-specialisation",
    claim:
      "The Modern Software and AI Engineering section on Scaler's homepage says the program includes a specialisation in Generative AI focused on building, evaluating, and shipping production AI systems.",
    sourceUrl: "https://www.scaler.com/",
    confidence: 0.93,
    tags: ["genai", "applied-ai", "software-engineering"],
  },
  {
    id: "homepage-mentor-practitioner",
    claim:
      "Scaler states that mentors are active industry professionals who review work, unblock learners, and bring current real-world judgment from teams building in the industry today.",
    sourceUrl: "https://www.scaler.com/",
    confidence: 0.88,
    tags: ["mentors", "practitioner", "credibility"],
  },
  {
    id: "homepage-projects-evaluated-practice",
    claim:
      "Scaler says projects, AI labs, and evaluated practice are integrated module by module so learners repeatedly apply concepts rather than only study them theoretically.",
    sourceUrl: "https://www.scaler.com/",
    confidence: 0.89,
    tags: ["projects", "hands-on", "practice"],
  },
  {
    id: "homepage-community-access",
    claim:
      "Scaler highlights structured check-ins, career support, and access to a 100,000+ alumni community, positioning the network as part of the long-term value of the program.",
    sourceUrl: "https://www.scaler.com/",
    confidence: 0.84,
    tags: ["community", "career-support", "network"],
  },
  {
    id: "homepage-lifelong-learning",
    claim:
      "Scaler states that learners get lifetime access to recorded content and ongoing curriculum updates so the material evolves with the market.",
    sourceUrl: "https://www.scaler.com/",
    confidence: 0.86,
    tags: ["lifetime-access", "curriculum-updates", "ongoing-learning"],
  },
  {
    id: "homepage-outcomes",
    claim:
      "Scaler's homepage presents assessed 2024 cohort outcomes including a career transition rate, a median post-program CTC, and a median hike, which can be used only as reported high-level outcome signals rather than personalized promises.",
    sourceUrl: "https://www.scaler.com/",
    confidence: 0.78,
    tags: ["outcomes", "roi", "career-transition"],
  },
  {
    id: "academy-structure",
    claim:
      "The Academy page describes a structured curriculum covering programming foundations, DSA, system design, and real-world projects under expert guidance.",
    sourceUrl: "https://www.scaler.com/academy/",
    confidence: 0.9,
    tags: ["structure", "curriculum", "software-engineering"],
  },
  {
    id: "academy-mentorship",
    claim:
      "The Academy page emphasizes personalized mentorship, regular 1:1 sessions, and mock interview support for career preparation.",
    sourceUrl: "https://www.scaler.com/academy/",
    confidence: 0.9,
    tags: ["mentorship", "interview-prep", "career-support"],
  },
  {
    id: "about-industry-veterans",
    claim:
      "Scaler's About page describes the platform as an online upskilling ecosystem where learners are taught and guided by industry veterans and experts from leading tech organizations.",
    sourceUrl: "https://www.scaler.com/about/",
    confidence: 0.87,
    tags: ["instructors", "credibility", "industry"],
  },
  {
    id: "curriculum-ai-modules",
    claim:
      "The AI engineering curriculum explicitly includes modules on RAG pipelines, Vector Databases (Pinecone/Milvus), Agentic Workflows (LangChain/LlamaIndex), and fine-tuning open-source LLMs.",
    sourceUrl: "https://www.scaler.com/academy/",
    confidence: 0.95,
    tags: ["genai", "modules", "curriculum", "applied-ai"],
  },
  {
    id: "program-fee-structure",
    claim:
      "The program fee is ₹3.5L (inclusive of taxes). This covers the entire duration of the program, including lifelong access to recorded content and the alumni network.",
    sourceUrl: "https://www.scaler.com/faq/",
    confidence: 0.98,
    tags: ["fee", "pricing", "financing", "roi"],
  },
  {
    id: "financing-emi-options",
    claim:
      "Scaler offers flexible financing including no-cost EMI options starting from approximately ₹10,000 to ₹12,000 per month, subject to approval from financing partners.",
    sourceUrl: "https://www.scaler.com/faq/",
    confidence: 0.94,
    tags: ["emi", "financing", "affordability"],
  },
  {
    id: "entrance-test-format",
    claim:
      "The entrance test is a 45-minute MCQ and coding assessment designed to test logical reasoning and basic programming aptitude, not advanced framework knowledge.",
    sourceUrl: "https://www.scaler.com/faq/",
    confidence: 0.92,
    tags: ["entrance-test", "screening", "admissions"],
  },
  {
    id: "cohort-timings",
    claim:
      "Live classes are held outside standard working hours (typically evenings or weekends) to accommodate working professionals without requiring them to quit their jobs.",
    sourceUrl: "https://www.scaler.com/academy/",
    confidence: 0.91,
    tags: ["schedule", "timing", "working-professionals"],
  },
  {
    id: "placement-support-criteria",
    claim:
      "Placement support, including access to the job portal and employer referrals, unlocks after learners successfully clear the mock interviews and meet the attendance/project criteria.",
    sourceUrl: "https://www.scaler.com/academy/",
    confidence: 0.89,
    tags: ["placements", "career-support", "jobs"],
  }
];

export function selectEvidenceForInsights(insights = {}) {
  const tags = new Set([
    ...(insights.recommended_proof || []),
    ...(insights.purchase_barriers || []),
    ...(insights.goals || []),
  ]);

  const matches = scalerEvidencePack.filter((item) =>
    item.tags.some((tag) => tags.has(tag))
  );

  return matches.length ? matches.slice(0, 6) : scalerEvidencePack.slice(0, 6);
}
