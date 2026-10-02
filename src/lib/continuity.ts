export type CanonRecord = {
  id: string;
  type: string;
  name: string;
  status: "LOCKED" | "DEVELOPING" | "UNKNOWN" | "RETIRED";
  content: Record<string, unknown>;
  tags: string[];
  searchText: string;
};

export type Scene = { ordinal: number; title?: string | null; summary: string; approved: boolean };

const tokenize = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);

export function rankCanon(query: string, entries: CanonRecord[], limit = 20): CanonRecord[] {
  const q = tokenize(query);
  return entries
    .filter((e) => e.status !== "RETIRED")
    .map((entry) => {
      const hay = tokenize(`${entry.name} ${entry.type} ${entry.tags.join(" ")} ${entry.searchText}`);
      let score = entry.status === "LOCKED" ? 4 : entry.status === "DEVELOPING" ? 2 : 0;
      for (const token of q) if (hay.has(token)) score += 3;
      if (query.toLowerCase().includes(entry.name.toLowerCase())) score += 10;
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.entry);
}

export function buildContinuityPacket(input: {
  projectName: string;
  request: string;
  canon: CanonRecord[];
  scenes: Scene[];
}) {
  const selected = rankCanon(input.request, input.canon);
  const recentScenes = input.scenes.filter((s) => s.approved).sort((a, b) => b.ordinal - a.ordinal).slice(0, 5);

  return {
    protocol: "CONTINUITY_V1",
    project: input.projectName,
    operating_rule: "User canon is authoritative. Never contradict LOCKED canon. Do not invent missing canon as fact.",
    request: input.request,
    canon: selected.map(({ searchText, ...safe }) => safe),
    recent_approved_scenes: recentScenes,
    output_contract: {
      lock: "State the canon facts that materially constrain the next beat.",
      prompt: "Continue the user's requested prose/image/video task using only compatible canon.",
      continuity_check: "List contradictions prevented, unresolved unknowns, and any proposed permanent changes."
    }
  };
}
