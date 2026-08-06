/**
 * Detect when an AI response contains a choice prompt — a question followed
 * by numbered or bulleted options. Returns the extracted options, or null
 * if the response doesn't look like a choice prompt.
 */
export function parseChoicePrompt(text: string): { question: string; options: Array<{ label: string; value: string }> } | null {
  if (!text || text.length > 2000) return null;

  // Patterns that signal the AI is asking the user to choose
  const questionPatterns = [
    /(?:which|what|would you|do you|shall|should|can I|may I|want me to|prefer|like me to|suggest|recommend)\b.*[?？]\s*$/im,
    /(?:choose|select|pick|enter|type)\s+(?:one|an?|the)\b.*[?？]?\s*$/im,
    /(?:options?|choices?|alternatives?|possibilities?)\s*[:：]\s*$/im,
    /(?:here are|these are|the following)\s+(?:the\s+)?(?:options?|choices?|alternatives?)\s*[:：]/im,
  ];

  // Check if the text ends with a question or choice prompt
  const lines = text.split('\n');
  const lastLines = lines.slice(-5).join('\n').trim();

  let hasQuestion = false;
  for (const pattern of questionPatterns) {
    if (pattern.test(lastLines)) {
      hasQuestion = true;
      break;
    }
  }

  if (!hasQuestion) return null;

  // Extract numbered or bulleted options
  const optionPatterns = [
    /^\s*(?:\d+[\.\)]\s*[-–—]?\s*|[-–—•*]\s+)(.+)$/gm,
  ];

  const options: Array<{ label: string; value: string }> = [];
  for (const pattern of optionPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const label = match[1].trim();
      if (label && label.length > 0 && label.length < 200) {
        options.push({ label, value: label });
      }
    }
  }

  // Need at least 2 options to be a choice prompt
  if (options.length < 2 || options.length > 10) return null;

  // Extract the question (everything before the first option)
  const firstOptionIdx = text.search(/^\s*(?:\d+[\.\)]\s*[-–—]?\s*|[-–—•*]\s+)/m);
  const question = firstOptionIdx > 0
    ? text.substring(0, firstOptionIdx).trim()
    : text.trim();

  return { question, options };
}
