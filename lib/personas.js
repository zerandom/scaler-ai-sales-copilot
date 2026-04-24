export const benchmarkPersonas = [
  {
    id: "rohan",
    name: "Rohan Sharma",
    role: "Software Engineer, TCS",
    experience: "4 years",
    intent:
      "Want to switch to a product company, tired of service work, interested in AI engineering roles.",
    links: "B.Tech CSE, VIT Vellore '20. SDE-2 at TCS for 4 years. Banking clients: HDFC, Citi. AWS Solutions Architect certified.",
    notes:
      "Motivated by career transition, skeptical about paying for content that appears free elsewhere, wants practical LLM application depth.",
    transcript:
      "BDA: Rohan, what's bringing you to Scaler? Rohan: I've been at TCS for 4 years. Banking projects. I want to move to a product company — and I keep seeing AI engineering roles and wondering if I'm already too late. BDA: Not too late. Have you looked at our AI Engineering program? Rohan: I've looked. Here's my question though — why should I pay ₹3.5L when Andrew Ng has basically the same stuff for free on Coursera? What's actually different? BDA: Good question, let me get back to you on the specifics. Rohan: Also — realistically, what salary jump does someone like me get? If I'm going from 14 LPA at TCS to 16 at another service company, the math doesn't work. BDA: We have data on that, I'll share. Rohan: One more — I want to build real LLM applications. RAG, agents, evals. Is your program on that, or is it more theoretical ML? BDA: We'll cover everything you need.",
  },
  {
    id: "karthik",
    name: "Karthik Iyer",
    role: "Senior Software Engineer, Google",
    experience: "9 years",
    intent:
      "Exploring AI engineering and evaluating whether Scaler offers anything meaningfully beyond self-study and internal learning.",
    links:
      "IIT Madras CS. 6 years at Google Search infra. Previously Microsoft. Frequent open-source contributor.",
    notes:
      "Very senior. Needs peer-level credibility, applied depth, strong cohort quality, and production-system relevance.",
    transcript:
      "BDA: Karthik, thanks for your time. Tell me what got you interested in Scaler. Karthik: Honestly, I'm exploring. I already work at Google. I can read the papers. I just want to make sure I'm not missing anything on the applied side. BDA: Of course. What would you want to learn? Karthik: My real question is — what would I actually learn here that I can't pick up from papers or internal training? I need to be honest about that before I commit. BDA: Our curriculum is very hands-on — Karthik: Also — is your cohort going to be at my level? Because if I'm tutoring everyone, I'm not getting value. BDA: We have senior folks, yeah. Karthik: Last one — are your instructors people who've actually shipped production AI systems, or is it academic? I've sat through enough academic ML.",
  },
  {
    id: "meera",
    name: "Meera Patel",
    role: "Final-year B.Tech student",
    experience: "0 years",
    intent:
      "Needs a job, has a government offer through campus, but wants a product-company path instead.",
    links: "Final-year B.Tech student from a tier-3 college. No LinkedIn provided.",
    notes:
      "High emotional stakes. Family approval, affordability, job-risk framing, and entrance-test confidence matter more than curriculum jargon.",
    transcript:
      "BDA: Meera, tell me what's on your mind. Meera: I'm in my final year. I got a government job offer through campus. My parents want me to take it. But I want to work at a product company. I'm confused. BDA: I understand. How can we help? Meera: The first thing my parents are going to ask is — can you guarantee I'll get a job after this? Because if I don't, I've turned down a secure government job for nothing. BDA: We have strong placement — Meera: And ₹3.5L is more than what my family earns in a year. I genuinely don't know how people afford this. How does that work? BDA: We have financing options. Meera: Also — I'm nervous about your entrance test. What if I can't clear it? Does that mean I'm not right for this?",
  },
];

export function detectPersonaStrategy(leadProfile = {}) {
  const composite = [
    leadProfile.name,
    leadProfile.role,
    leadProfile.intent,
    leadProfile.notes,
    leadProfile.transcript,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    composite.includes("google") ||
    composite.includes("senior") ||
    composite.includes("production ai")
  ) {
    return {
      key: "senior-operator",
      title: "Peer-level applied depth",
      voice: "Concise, intellectually honest, zero fluff.",
      palette: ["#0e2238", "#c96b36", "#f2e8dc"],
      heroLabel: "For engineers who already know the theory",
      sections: [
        "What you would actually learn here",
        "Production relevance",
        "Who teaches and how",
        "Why the peer group matters",
        "Next step",
      ],
    };
  }

  if (
    composite.includes("final-year") ||
    composite.includes("parents") ||
    composite.includes("government")
  ) {
    return {
      key: "career-risk",
      title: "Confidence and decision support",
      voice: "Warm, practical, reassuring, never overpromising.",
      palette: ["#5a2a27", "#d5a021", "#fff7e8"],
      heroLabel: "A clearer path through a high-stakes career decision",
      sections: [
        "Your decision context",
        "What Scaler can support",
        "Questions your family will ask",
        "How financing and screening fit in",
        "Next step",
      ],
    };
  }

  return {
    key: "transition-builder",
    title: "ROI and applied transition plan",
    voice: "Practical, energetic, direct.",
    palette: ["#123524", "#4f8f63", "#eef7f0"],
    heroLabel: "From service work to applied AI execution",
    sections: [
      "What changes for you",
      "Questions answered directly",
      "What you would build",
      "Why structure matters beyond free content",
      "Next step",
    ],
  };
}
