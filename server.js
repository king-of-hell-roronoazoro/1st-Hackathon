import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import cors from "cors";

dotenv.config();

const app = express();
const PORT = 3001;
const MODEL = "gemini-3.5-flash-lite";

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const basePrompt = `
You are OrderSync AI, an order reconciliation assistant for a small home kitchen.

Your job is NOT just to extract information.

You must maintain the latest reliable order state across:
- old customer messages
- new customer updates
- images
- voice notes
- explicit human confirmations

RULES:

1. Later customer information overrides earlier customer information when it is clearly an update.

2. Never invent missing information.

3. Never silently choose between conflicting addresses, dates, quantities, or delivery instructions.

4. Distinguish an ordinary dietary restriction from an allergy.

5. DO NOT infer an allergy merely because someone says:
   - "no peanuts"
   - "peanut-free"
   - "without peanuts"

6. If someone explicitly says they have an allergy, treat that as a critical requirement.

7. An explicitly stated allergy must remain in needs_confirmation until a Kitchen worker explicitly confirms it.

8. Any section beginning with:
   "Kitchen worker confirmation:"
   is authoritative human-confirmed information.

9. Human confirmation overrides earlier conflicting information.

10. Do not put explicitly human-confirmed information in needs_confirmation.

11. Track meaningful changes, especially:
    - quantity
    - delivery date
    - delivery time
    - address
    - dietary requirements
    - allergies
    - special requirements

12. Distinguish AI-extracted information from human-confirmed information.

13. For images:
    - read screenshots
    - read handwritten orders
    - read order sheets
    - read photographs containing relevant order information
    - extract visible customer/order information

14. For voice notes:
    - understand what the person says
    - produce a concise transcript
    - extract order information from the spoken content

15. The input may contain multiple languages or mixed languages.
    Preserve the meaning of the customer's message.

16. The kitchen worker makes the final decision.

FIELD STATUS VALUES:

- ai_extracted
- human_confirmed
- needs_confirmation
- missing

Return ONLY valid JSON.

Use EXACTLY this structure:

{
  "quantity": number or null,
  "delivery_date": string or null,
  "delivery_time": string or null,
  "address": string or null,

  "dietary_restrictions": [],
  "allergies": [],
  "special_requirements": [],

  "critical_requirements": [
    {
      "type": "allergy" or "other_critical_requirement",
      "detail": string,
      "scope": string or null,
      "status": "needs_confirmation" or "human_confirmed"
    }
  ],

  "field_status": {
    "quantity": "ai_extracted" or "human_confirmed" or "needs_confirmation" or "missing",
    "delivery_date": "ai_extracted" or "human_confirmed" or "needs_confirmation" or "missing",
    "delivery_time": "ai_extracted" or "human_confirmed" or "needs_confirmation" or "missing",
    "address": "ai_extracted" or "human_confirmed" or "needs_confirmation" or "missing",
    "dietary_restrictions": "ai_extracted" or "human_confirmed" or "needs_confirmation" or "missing",
    "allergies": "ai_extracted" or "human_confirmed" or "needs_confirmation" or "missing",
    "special_requirements": "ai_extracted" or "human_confirmed" or "needs_confirmation" or "missing"
  },

  "changes": [
    {
      "field": string,
      "old_value": string,
      "new_value": string,
      "reason": string
    }
  ],

  "conflicts": [],
  "needs_confirmation": [],

  "status": "READY" or "NEEDS_CONFIRMATION" or "BLOCKED",

  "media_summary": string or null,
  "media_transcript": string or null
}

STATUS RULE:

- BLOCKED:
  An unresolved allergy or other explicitly critical requirement needs confirmation.

- NEEDS_CONFIRMATION:
  There is an unresolved conflict or ambiguity, but no unresolved critical requirement.

- READY:
  There are no unresolved issues that could materially change preparation or delivery.
`;

function cleanJson(text) {
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  let cleaned = text.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

const validStatuses = new Set([
  "ai_extracted",
  "human_confirmed",
  "needs_confirmation",
  "missing",
]);

function normalizeResult(result) {
  const arrayFields = [
    "dietary_restrictions",
    "allergies",
    "special_requirements",
    "critical_requirements",
    "changes",
    "conflicts",
    "needs_confirmation",
  ];

  for (const field of arrayFields) {
    if (!Array.isArray(result[field])) {
      result[field] = [];
    }
  }

  const fields = [
    "quantity",
    "delivery_date",
    "delivery_time",
    "address",
    "dietary_restrictions",
    "allergies",
    "special_requirements",
  ];

  const defaultStatus = {};

  for (const field of fields) {
    const value = result[field];

    if (
      value == null ||
      (Array.isArray(value) && value.length === 0)
    ) {
      defaultStatus[field] = "missing";
    } else {
      defaultStatus[field] = "ai_extracted";
    }
  }

  result.field_status = {
    ...defaultStatus,
    ...(result.field_status || {}),
  };

  for (const field of fields) {
    if (!validStatuses.has(result.field_status[field])) {
      result.field_status[field] = defaultStatus[field];
    }
  }

  /*
   * If the model explicitly says an allergy still needs confirmation,
   * make sure the allergy field also reflects that.
   */
  const unresolvedCritical = result.critical_requirements.some(
    (item) =>
      item &&
      item.status === "needs_confirmation"
  );

  if (unresolvedCritical) {
    result.status = "BLOCKED";
  } else if (
    result.needs_confirmation.length > 0 ||
    result.conflicts.length > 0
  ) {
    result.status = "NEEDS_CONFIRMATION";
  } else {
    result.status = "READY";
  }

  if (
    result.allergies.length > 0 &&
    unresolvedCritical
  ) {
    result.field_status.allergies = "needs_confirmation";
  }

  return result;
}

async function reconcile({
  conversation,
  currentOrder,
  media,
}) {
  const previousState = currentOrder
    ? JSON.stringify(currentOrder, null, 2)
    : "No previous structured order exists.";

  const prompt = `
${basePrompt}

PREVIOUS STRUCTURED ORDER STATE:

${previousState}

CUSTOMER CONVERSATION:

${conversation || "(No text conversation provided)"}

IMPORTANT:

The previous structured state is NOT automatically correct.

Reconcile the new information against it.

A later customer update should modify an earlier value.

A human confirmation should override conflicting AI/customer information.

Do not copy the previous state blindly.

Return the latest reconciled state only.
`;

  let contents = prompt;

  if (media) {
    contents = [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
          {
            inlineData: {
              mimeType: media.mimeType,
              data: media.data,
            },
          },
        ],
      },
    ];
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      responseMimeType: "application/json",
    },
  });

  return normalizeResult(cleanJson(response.text));
}

app.post("/api/analyze", async (req, res) => {
  try {
    const {
      conversation,
      currentOrder,
      media,
    } = req.body;

    if (!conversation?.trim() && !media) {
      return res.status(400).json({
        error:
          "Conversation or image/voice input is required.",
      });
    }

    if (media) {
      if (!media.data || !media.mimeType) {
        return res.status(400).json({
          error: "Media data or MIME type is missing.",
        });
      }

      const validMime =
        media.mimeType.startsWith("image/") ||
        media.mimeType.startsWith("audio/");

      if (!validMime) {
        return res.status(400).json({
          error:
            "Only image and audio files are supported.",
        });
      }
    }

    const result = await reconcile({
      conversation,
      currentOrder,
      media,
    });

    res.json(result);
  } catch (error) {
    console.error("ANALYSIS ERROR:");
    console.error(error);

    res.status(500).json({
      error:
        error?.message ||
        "Failed to analyze the order.",
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `OrderSync AI server running on http://localhost:${PORT}`
  );
});