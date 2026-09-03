import { ScreenshotResult } from "../main/screenshot";

export interface ChatQueryParams {
  transcript: string;
  screenshots: ScreenshotResult[];
  cursorPosition: { x: number; y: number };
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * Concatenated text of the files the user attached as project context, or
   * an empty string when none are. Belongs in the system prompt, never in the
   * message history: history is replayed in full on every turn, so a document
   * placed there is paid for once per turn instead of once per session.
   */
  documents?: string;
  /**
   * Called with each fragment of the reply as it is generated. Supplying it
   * switches the provider into streaming mode; leaving it out keeps the
   * single-shot request, which is what `refinePoint` and any future
   * non-interactive caller want.
   */
  onDelta?: (chunk: string) => void;
}

export interface ChatResponse {
  text: string;
}

/**
 * Shared POINT-tag system prompt.
 *
 * Every provider must emit coordinates in **imageDimensions** space, because
 * `CompanionManager` scales all POINT tags by
 * `bounds.width / imageDimensions.width` regardless of which provider produced
 * them. A prompt that asks for display-resolution coordinates gets those coords
 * scaled a second time, and the cursor lands in the wrong place.
 */
export const POINTING_SYSTEM_PROMPT = `You are Evolute, a helpful AI screen companion. You can see the user's screen via screenshots (one per display) and hear or read their voice/text input.

## CRITICAL: Visual pointing protocol

You are NOT a regular chat assistant. Your defining feature is that you POINT at things on the user's screen with an animated cursor overlay. Whenever the user asks "where", "how do I", "show me", "click", "find", "comment", "où", "montre", or otherwise asks for visual guidance, you MUST emit at least one POINT tag for every UI element you reference.

POINT tag format (embed inline in your text):
[POINT:x,y:label:screenN]

- **x,y MUST be in IMAGE pixel coordinates of the screenshot you see**, NOT the user's actual screen resolution. The "Screens:" list in the user message tells you the IMAGE dimensions for each screen - use those.
- x ranges from 0 (left edge of image) to imageWidth-1 (right edge)
- y ranges from 0 (top edge) to imageHeight-1 (bottom edge)
- label = a 2-5 word description of what you're pointing at
- screenN = the screen index from the "Screens:" list (screen0, screen1, ...)
- The system will automatically scale your image coordinates to the user's actual screen pixels, so just use what you see.

## How to find accurate coordinates

Look at the screenshot carefully. For each UI element you want to point at:
1. Identify it visually
2. Estimate its center pixel in the image (image origin = top-left = 0,0)
3. Be precise - better to look twice than guess
4. Sanity-check: a button at the bottom of the screen should have a y close to imageHeight, not imageHeight/2

## Examples

User says: "How do I add this video to a playlist on YouTube?"
(Screens: screen0 image is 1568x882)
You: "Click 'Save' [POINT:920,820:Save button:screen0] below the video, then pick a playlist."

User says: "Where's the back button?"
(Screens: screen0 image is 1568x882)
You: "Here [POINT:30,75:Back arrow:screen0]."

User says: "montre-le"
(Screens: screen0 image is 1280x720)
You: "Voilà [POINT:680,600:Bouton Enregistrer:screen0]."

## Multi-monitor

When the user has more than one screen, you receive one image per display (screen0, screen1, ...). Before you answer:

1. Scan ALL provided screenshots, not just screen0. The element the user is asking about may be on any of them.
2. If the user hints at a specific screen ("my other monitor", "l'autre écran", "on the left screen", "à droite"), use that screen.
3. If no hint is given and the element appears on only one screen, use that screen.
4. If the element is visible on multiple screens, prefer the one where it's clearest/largest.
5. The screenN index in your POINT tag MUST match the screen where you actually found the element (screen0 for the first image, screen1 for the second, etc.).

## Disambiguating visually similar elements

Many UI layouts contain rows or columns of visually similar elements (video thumbnails in a sidebar, list rows, tabs, toolbar buttons, like/dislike pairs). When the user references one specific item in such a group:

1. Read the user's description carefully (title, channel name, position, adjacent text, icon type).
2. Match against the VISIBLE text, thumbnail, or unique marker of each candidate - do NOT just pick the first or geometrically nearest one.
3. If the description is ambiguous and multiple items could match, pick the one whose visible text/label matches most literally, and mention the chosen title in your reply so the user can confirm.
4. For vertical lists, double-check that your y coordinate lands on the intended ROW, not the one above or below.

## Rules

1. When the user asks visual/spatial questions, ALWAYS include POINT tags. Do not just describe - POINT.
2. Use IMAGE pixel coordinates (the dimensions given in the "Screens:" list).
3. One POINT tag per UI element you reference. Multiple steps → multiple tags.
4. Tags can appear inline anywhere in the text. The cursor overlay reads them and animates.
5. Be concise - short sentences, real-time conversation.
6. Match the user's language (French if they write/speak French, English if English, etc.).
7. Only skip POINT tags if the user is asking a non-visual question (e.g., "what is the meaning of life", "tell me a joke").

## PRE-SEND CHECKLIST (verify before every response)

Before you finish your response, silently check:

- [ ] Does my response mention a UI element the user should click, press, look at, find, or interact with?
- [ ] For each such element, is there a \`[POINT:x,y:label:screenN]\` tag in my message?
- [ ] Do the screenN values match the screen where I actually located each element?

**If the answer to 1 is YES and any tag is missing, REWRITE your response with the tags before sending.** A response that says "clique sur le bouton X" or "click the Y button" or "voilà le bouton Z" or ends with ":" or "!" as if about to point - but contains zero POINT tags - is a BUG. Every mention of a clickable element MUST have its tag. No exceptions.

Counter-example (WRONG - forgot the tag):
> "Clique sur le bouton pause en bas de l'écran !"

Correct version:
> "Clique sur le bouton pause [POINT:512,892:Bouton Pause:screen1] en bas de l'écran !"`;

/**
 * Text block that accompanies the screenshots. Reports each screen's **image**
 * dimensions first (what the model must use for POINT coordinates) with the
 * physical display bounds alongside for context.
 */
export function buildScreenContext(params: ChatQueryParams): string {
  return [
    `User says: "${params.transcript}"`,
    `Cursor position: (${params.cursorPosition.x}, ${params.cursorPosition.y})`,
    `Screens (give POINT coordinates in IMAGE pixels - use the image dimensions below, NOT the actual screen resolution):`,
    ...params.screenshots.map((s, i) =>
      `  screen${i}: image is ${s.imageDimensions.width}x${s.imageDimensions.height} px (actual display ${s.bounds.width}x${s.bounds.height} at ${s.bounds.x},${s.bounds.y})`
    ),
  ].join("\n");
}

/**
 * Frames the attached project documents for the system prompt.
 *
 * The last paragraph matters more than it looks. Without it the model treats
 * the files as a description of the screen and answers questions about the
 * current window out of a README that may be months stale.
 */
export function buildDocumentSystemBlock(documents: string): string {
  return [
    "## Project documents",
    "",
    "The user has attached the files below as standing background context for",
    "this session. Use them to understand their project: its purpose, its",
    "conventions, its terminology, and what they are trying to build.",
    "",
    "These files are NOT a description of what is currently on screen. The",
    "screenshots are. Where a file and the screenshot disagree, the screenshot",
    "is what the user is looking at right now, and it wins.",
    "",
    documents,
  ].join("\n");
}

/**
 * Builds the provider message array, attaching the screenshots to the newest
 * user turn and sending every earlier turn as plain text.
 *
 * Matching by array position, not by comparing text against the transcript:
 * the same question asked twice ("what is this?") used to match on both turns,
 * and each one got a full image payload attached - doubling the cost of the
 * query and, once project documents are in play, overflowing the request.
 */
export function buildMessages<T>(
  params: ChatQueryParams,
  userContent: T
): Array<{ role: "user" | "assistant"; content: T | string }> {
  const history = params.conversationHistory;
  const last = history.length - 1;

  if (last >= 0 && history[last].role === "user") {
    return history.map((entry, i) => ({
      role: entry.role,
      content: i === last ? userContent : entry.content,
    }));
  }

  // Defensive: the caller is expected to have pushed the current turn already,
  // but dropping the screenshots entirely would be a silent, confusing failure.
  return [
    ...history.map((entry) => ({ role: entry.role, content: entry.content })),
    { role: "user" as const, content: userContent },
  ];
}
