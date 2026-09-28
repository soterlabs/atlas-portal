# The Atlas GraphRAG KG — data contract (schema v1)

2026-09-04. This is the contract the graph artifact builder
(`scripts/build-graph-artifact.ts`) codes against. Five JSON files, all UTF-8, all anchored to the Atlas
section identifiers the existing keyword and embedding indexes
already use: the section id (`A.1.2.3`) and the heading UUID. Every
mention carries a verbatim quote so a search result can show WHAT
appears WHERE.

Versioning: `meta.json.schema_version` bumps on any breaking change
to this contract (v2 added the entity `tier` and `stands_for` fields
and the `refinement` audit block in meta — additive, so v1 readers
still parse); `meta.json.atlas_version` names the Atlas snapshot
the files were generated from. Consumers should reject a file set
whose `schema_version` they do not know.

## sections.json — every heading as a node

```json
[
  {
    "id": "A.0.1.1.1",
    "uuid": "4f6fda1e-7450-4065-8095-e93cb10b3a2a",
    "title": "Organizational Alignment",
    "node_type": "Core",
    "parent": "A.0.1.1",
    "file": "A.0 - Atlas-Preamble.md",
    "depth": 4
  }
]
```

- `id` is unique across the set. Two id families exist: the
  numbered tree (`A.1.2.3`, including `.varN` scenario variants) and
  free-standing research notes (`NR-1`). `parent` is the nearest
  EXISTING ancestor — the export skips numbering levels, so the
  parent of `A.1.1.0.3.1` may be `A.1.1`; NR notes parent by their
  position in the heading nesting; scope roots have `null`.
- `node_type` is the bracketed tag from the heading
  (`Scope`, `Article`, `Section`, `Core`, ...), `null` if absent.
- `file` names the source file in the per-file Atlas export.
- `depth` is the markdown heading level (number of `#`), not the id
  component count.

## entities.json — canonical entities

```json
[
  {
    "id": "executor_agent",
    "name": "Executor Agent",
    "aliases": ["Executors"],
    "type": null,
    "summary": null,
    "basis": ["defined-term", "capitalized-phrase"],
    "mention_count": 214,
    "tier": "concept",
    "stands_for": null
  }
]
```

- `id` is the lowercased, underscored canonical name — stable across
  regenerations.
- `type` is one of the 22 entity types when assigned (GR2),
  else `null`. `summary` is a one-line description (GR2), else
  `null`. GR1 emits rule-based entities with both fields `null`.
- `basis` says which signals created the entity
  (`defined-term`, `capitalized-phrase`, `acronym`, `extracted`).
- `tier` (schema v2, DP-GR7) is `concept` — the vocabulary people
  consciously search — or `instance` — identifiers, code tokens,
  numbers, agent names, persons: the legitimately large inventory.
  Consumers may weight the two differently.
- `stands_for` (schema v2) carries an acronym's expansion when the
  document defines it parenthetically ("Long Form (ACRO)"); the
  expansion is also an alias, so either form resolves to the one
  entity. `null` otherwise.
- Every entity passed the name gate: function words and bare
  abstractions are refused at admission, lowercase single words are
  judged (standalone thing vs fragment); refusals are recorded in
  `meta.json.refinement.refusals` with their reasons.

## mentions.json — what appears where (the display backbone)

```json
[
  {
    "entity": "executor_agent",
    "section_id": "A.6.1.2.1",
    "uuid": "...",
    "quote": "Executor Agents (\"Executors\") are specialized ...",
    "count": 3
  }
]
```

- One row per (entity, section) pair; `count` is the number of
  occurrences in that section; `quote` is the first containing
  sentence, verbatim, truncated at 300 characters.

## edges.json — typed links, each with provenance

```json
[
  { "s": "A.0.1.1", "r": "contains", "o": "A.0.1.1.1", "kind": "section-section" },
  {
    "s": "A.1.2.3",
    "r": "references",
    "o": "A.4.5",
    "kind": "section-section",
    "quote": "... as defined in A.4.5 ..."
  },
  {
    "s": "executor_agent",
    "r": "implements",
    "o": "business_activity",
    "kind": "entity-entity",
    "section_ids": ["A.6.1.2.1"],
    "quote": "..."
  }
]
```

- `kind` ∈ `section-section` | `entity-entity` | `entity-section`.
- `opposite_of` (schema v2, DP-GR8) is a symmetric entity-entity
  relation stored once (`s` < `o`), with `basis` (`prefix-mis`,
  `prefix-non`, …, or `cue-judged`) and `opposition_kind` —
  `antonym` (contrary meanings) or `failure` (one is the undesired
  state of the other); `section_ids` are the sections where both
  appear, `quote` the contrasting sentence when a textual cue found
  the pair.
- A typed dependency edge may carry `"oppositional": true`: its
  relation wording was judged to mean the subject works AGAINST the
  object (prevents, erodes, breaks, contradicts…). Search can present
  "related but opposing" results by following `opposite_of` edges
  plus edges with this flag. The flagged wordings are listed in
  `meta.json.opposition.oppositional_relations`.
- Every typed entity-entity edge carries `canonical` (schema v2,
  DP-GR9): the relation name from the closed vocabulary in
  `relations.json`. `r` stays the wording the extraction produced
  (evidence, never rewritten). When the wording read the relation
  backwards (`is_defined_by`, `specified_in`), `s` and `o` were
  swapped so the canonical reads in its fixed direction, and
  `"swapped": true` records that. Query on `canonical`, display `r`
  and `quote`. Wordings used once that match nothing land on the
  coarse canonical `related_to`. The `oppositional` flag is decided
  per canonical (majority of its edges), so it is consistent within a
  relation.
- `entity-section` edges (schema v2, DP-GR10) come from the Atlas's
  title convention, basis `structural`: a section titled
  "Thing + Aspect" states that aspect of the thing and its body is
  the value, so "Operator Multisig Address" gives
  `has_address(operator_multisig, section)`. `r` is the aspect
  wording as the title had it (plural-folded: `payment address`),
  `canonical` the relation name a judge assigned ONCE per aspect
  wording (`data/graphrag/title-aspects.json`: `has_address`,
  `has_location`, `has_maximum`, `has_parameter`, `has_duty`,
  `has_requirement`, `defines`, …; refused wordings emit nothing).
  Enumerated items inside the section are carried verbatim in
  `items`. `defines` (glossary entries "<Term> (ACRO)", terms under
  A.0.1.1, "<Term> Definition" sections) is stored with
  `r: "defined_in"`, `swapped: true`, so `s` is the section and `o`
  the entity, the GR9 convention. A title of the shape
  "Subject <participle> by Object" ("Asset Supplied By Spark
  Liquidity Layer") yields an `entity-entity` edge instead, read
  backwards through GR9's passive rule (`provides`, `swapped`), with
  every section stating it in `section_ids` (up to 5). The object of
  an aspect edge is the section, so a search result can show the
  value directly.
- Edges with basis `frequent` (schema v2, DP-GR11) come from reading
  the sections the sentence layer never covered, with a CLOSED
  vocabulary: the top-k canonical relations of what was already read
  (`data/graphrag/frequent-relations.json`, k and coverage inside).
  For these `r` equals `canonical` by construction; an unlisted
  relation was dropped, never admitted, so the vocabulary does not
  grow. Rare, specific relations are left to keyword search.
- GR1 emits the two deterministic section-section relations:
  `contains` (the numbering hierarchy) and `references` (an explicit
  section-id citation in the text, with the citing sentence as
  `quote`). GR3 adds `entity-entity` edges; entity→section linking
  is served by mentions.json rather than duplicated as edges.
- A `references` edge whose target id does not exist in
  sections.json is NOT emitted; it is reported in
  `meta.json.dangling_references` (data errors are surfaced, never
  silently dropped or invented).

## meta.json

```json
{
  "atlas_version": "2026-09-04",
  "generated": "...",
  "schema_version": 2,
  "counts": { "sections": 11456, "entities": 0, "mentions": 0, "edges_contains": 0, "edges_references": 0 },
  "dangling_references": [{ "from": "A.1.2", "target": "A.9.9", "quote": "..." }]
}
```
