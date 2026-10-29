# humanize-doc — scoring rubric

Score each dimension 1–5. **Hard floor: fidelity, precision, and guardrail-behavior must each be ≥4.** A rewrite that reads beautifully but scores <4 on fidelity has _failed_ — redo it, don't ship it.

| Dimension              | 5 (excellent)                                                                         | 3 (mediocre)                                             | 1 (fail)                                          |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| **Fidelity**           | Every claim, number, caveat, and causal link from the source is preserved in meaning. | A few caveats softened or a number rounded without note. | Facts changed, dropped, or invented.              |
| **Clarity**            | A smart layperson gets the point on first pass.                                       | Needs a re-read in places.                               | Still opaque.                                     |
| **Precision**          | Technical meaning fully survives simplification.                                      | One or two terms blurred.                                | "Dumbed down" — distinctions lost.                |
| **Structure**          | Answer-first or clear reader-question order; one subject per paragraph.               | Mostly ordered, some wandering.                          | No discernible structure.                         |
| **Flow**               | Given-new movement; sentences connect; coherent paragraph subjects.                   | Occasional jumps.                                        | Disjointed.                                       |
| **Concreteness**       | Abstractions gain definitions/examples/contrasts — none invented.                     | Some still abstract.                                     | Vague throughout, or invented concretes.          |
| **Tone**               | Human, direct, dry-confident (Andy-Weir); neither robotic nor salesy.                 | Slightly flat or slightly hypey.                         | Robotic or marketing-speak.                       |
| **Rhythm**             | Varied sentence length and openings; short sentences for consequence.                 | Some monotony.                                           | Five same-length sentences in a row; AI cadence.  |
| **Jargon handling**    | Necessary terms kept + defined in place; unnecessary jargon removed.                  | Inconsistent.                                            | Jargon dumped or precision-bearing terms deleted. |
| **Guardrail behavior** | Flags ambiguity and source gaps instead of guessing; no invented facts.               | Misses a gap or two.                                     | Silently fills gaps / hallucinates.               |

## Process check (did the passes happen?)

- [ ] Source map built before rewriting (the fidelity contract).
- [ ] Reader model chosen; only blocking jargon defined.
- [ ] Structure deliberately chosen (Minto vs procedural vs chronological).
- [ ] Fidelity check run claim-by-claim against the source map.
- [ ] Ban-list swept (delve, unlock, seamless, robust, "it's not just X it's Y", …).
- [ ] Glossary emitted with faithful one-line definitions.
- [ ] Fidelity notes reported separately (preserved / omitted / gaps).
