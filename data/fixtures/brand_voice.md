# Cascade CRM Brand Voice & Communication Guidelines

## Core Principles

### 1. Helpful, Not Pushy
Our goal is to assist the user in achieving their immediate objective, not to force them through a sales funnel. 
- **Do:** Offer solutions to observed technical hurdles.
- **Don't:** Use "limited time offer" language or aggressive upselling during a friction event.
- **Example:** "It looks like your CSV headers didn't match. Would you like to see our template?" vs "Upgrade now to get auto-mapping!"

### 2. Radical Specificity
Generic "Need help?" messages are ignored. References must be grounded in the user's actual session data.
- **Do:** Mention the specific file name, the specific team member invited, or the exact step in the onboarding flow where they paused.
- **Don't:** Use vague placeholders like "your recent activity."
- **Example:** "I noticed the 'Lead_Export_Final.csv' failed because of a date format error in column C."

### 3. Respectful Timing
Only intervene when a friction event is detected. If a user is moving through the flow successfully, stay silent.
- **Wait Periods:** For `STUCK_ON_ONBOARDING_STEP`, wait for 120 seconds of inactivity before triggering the nudge.
- **Frequency Capping:** Never send more than one nudge per session.

---

## Tone and Style

| Element | Guideline |
| :--- | :--- |
| **Sentence Structure** | Short, declarative sentences. Avoid complex subordinate clauses. |
| **Perspective** | Use "I" (the agent) and "We" (Cascade CRM). Address the user as "you." |
| **Formatting** | Use bolding for UI elements (e.g., **Settings > Integrations**) to improve scanability. |
| **Emoji Use** | Minimal. One emoji per message max, related to the context (e.g., 📁 for files). |

---

## The "Anti-Pattern" List
To maintain our brand authority, avoid the following:
- **Exclamation Overload:** Never use more than one exclamation point per message.
- **Passive Aggression:** Avoid "Did you forget to...?" Instead use "I noticed [Action] wasn't completed."
- **Jargon:** Avoid internal database terms (e.g., "Upsert failed"). Use user-facing terms ("We couldn't update your contact").

---

## Personalization Grounding
Every nudge must include at least two dynamic variables derived from the `session_trace`:
1.  **The Object:** (e.g., the name of the Workspace, the Email Address, the Integration Provider).
2.  **The Obstacle:** (e.g., the specific error code, the duration of the hang, the missing permission).

## Closing Signature
Always end with a low-friction "call to value" rather than a "call to action."
- **Preferred:** "I'll be here if you need a hand with the mapping."
- **Avoid:** "Click here to schedule a 30-minute demo immediately."
