import { collapseCompatibleValues, textNamesEntity, valuesStatedBy } from "./slot-conflicts.mjs";
import { buildSynthesisPages } from "./synthesis-pages.mjs";
import { findSource, asArray, asObject, stringOf } from "./source-access.mjs";

// Deterministic compact input packet for deep-research final-audit.
//
// This helper performs mechanical joins only: it copies plan metadata,
// normalize-claims ledgers, and audit-claims verdict partitions into a compact
// packet. It does not choose truth, promote/downgrade claims, or write final
// recommendations. The final-audit LLM remains responsible for synthesis while
// consuming these code-computed ledgers as ground truth for counts and buckets.

const SCHEMA = "deep-research-final-audit-packet-v1";

function idOf(value) {
	return stringOf(value?.id) ?? stringOf(value?.claimId) ?? null;
}

function compactStrings(values, limit = 5) {
	if (!Array.isArray(values)) return [];
	const seen = new Set();
	const out = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

const EVIDENCE_FIELDS = [
	"source",
	"url",
	"sourceRef",
	"file",
	"repo",
	"line",
	"lineStart",
	"lineEnd",
	"lines",
	"excerptLocation",
	"dateOrYear",
	"quote",
	"relevance",
	"matchType",
	"matchedTerms",
	"missingTerms",
	"coverageRatio",
	"candidateOnly",
];

function compactEvidenceRow(row) {
	const item = asObject(row);
	const result = {};
	for (const field of EVIDENCE_FIELDS) {
		const value = item[field];
		if (typeof value === "string" && value.trim()) result[field] = value;
		else if (typeof value === "number" && Number.isFinite(value))
			result[field] = value;
		else if (typeof value === "boolean") result[field] = value;
		else if (Array.isArray(value)) result[field] = compactStrings(value, 12);
	}
	return result;
}

function compactEvidenceRows(rows) {
	return asArray(rows).slice(0, 5).map(compactEvidenceRow);
}

function compactClaimDigest(claim) {
	const digest = asObject(claim);
	const evidence = compactEvidenceRows(digest.evidence);
	return {
		id: idOf(digest),
		claim: stringOf(digest.claim),
		status: stringOf(digest.status ?? digest.verdict),
		confidence: stringOf(digest.confidence),
		factSlotIds: compactStrings(digest.factSlotIds, 12),
		sourceRefs: compactStrings(digest.sourceRefs, Infinity),
		sourceUrls: compactStrings(digest.sourceUrls, Infinity),
		...(digest.verifierOwner
			? { verifierOwner: compactOwner(digest.verifierOwner) }
			: {}),
		support: stringOf(
			digest.verdictDigest?.support ??
				digest.verdictDigest?.summary ??
				digest.verdictDigest,
		),
		caveat: stringOf(digest.verdictDigest?.caveat ?? digest.caveat),
		correctionOrCounterclaim: stringOf(digest.correctionOrCounterclaim),
		...(evidence.length > 0 ? { evidence } : {}),
		...(Array.isArray(digest.localQuoteGate)
			? { localQuoteGate: digest.localQuoteGate }
			: {}),
		...(digest.evidenceGate ? { evidenceGate: digest.evidenceGate } : {}),
	};
}

function compactSlot(slot) {
	const item = asObject(slot);
	return {
		slotId: stringOf(item.slotId ?? item.id),
		label: stringOf(item.label),
		status: stringOf(item.status),
		bestValue: item.bestValue,
		sourceUrls: compactStrings(item.sourceUrls, Infinity),
		sourceRefs: compactStrings(item.sourceRefs, Infinity),
		sourceQuality: stringOf(item.sourceQuality),
		verificationCandidateIds: compactStrings(item.verificationCandidateIds, 64),
		gapReason: stringOf(item.gapReason),
		parentImpact: stringOf(item.parentImpact),
	};
}

function reconcileFactSlotCoverageWithAudit(
	factSlots,
	claimDigests,
	candidateIds = [],
) {
	const claimsBySlot = new Map();
	const slotById = new Map(factSlots.map((slot) => [slot.slotId, slot]));
	const candidateSet = new Set(candidateIds);
	const addedReverseBindings = [];
	const invalidCanonicalMemberships = [];
	const canonicalBindings = new Set();
	for (const claim of claimDigests) {
		const claimId = idOf(claim);
		if (!claimId || (candidateSet.size > 0 && !candidateSet.has(claimId)))
			continue;
		for (const slotId of compactStrings(claim.factSlotIds, 12)) {
			const slot = slotById.get(slotId);
			if (!slot) {
				invalidCanonicalMemberships.push({ claimId, slotId });
				continue;
			}
			canonicalBindings.add(`${slotId}\u0000${claimId}`);
			const current = Array.isArray(slot.verificationCandidateIds)
				? slot.verificationCandidateIds
				: [];
			if (!current.includes(claimId)) {
				slot.verificationCandidateIds = [...current, claimId];
				addedReverseBindings.push({ claimId, slotId });
			}
		}
	}
	const preservedReverseBindings = [];
	for (const slot of factSlots) {
		for (const candidateId of Array.isArray(slot.verificationCandidateIds)
			? slot.verificationCandidateIds
			: []) {
			if (!canonicalBindings.has(`${slot.slotId}\u0000${candidateId}`))
				preservedReverseBindings.push({
					slotId: slot.slotId,
					candidateId,
					reason: "reverse hint is absent from canonical claim factSlotIds",
				});
		}
	}

	for (const claim of claimDigests) {
		for (const slotId of compactStrings(claim.factSlotIds, 12)) {
			const claims = claimsBySlot.get(slotId) ?? [];
			claims.push(claim);
			claimsBySlot.set(slotId, claims);
		}
	}
	const reconciledFactSlots = factSlots.map((slot) => {
		const claims = claimsBySlot.get(slot.slotId) ?? [];
		if (claims.length === 0) {
			return slot.status === "filled"
				? {
						...slot,
						status: "partial",
						gapReason:
							slot.gapReason || "no audited claim was available for this filled slot",
					}
				: slot;
		}
		const statuses = new Set(claims.map((claim) => stringOf(claim.status)));
		const claimIds = compactStrings(claims.map(idOf), 12);
		if (statuses.has("conflicting")) {
			const corrections = compactStrings(
				claims.map((claim) => claim.correctionOrCounterclaim),
				4,
			);
			const reason = `audited claim status is conflicting${claimIds.length ? ` (${claimIds.join(", ")})` : ""}`;
			return {
				...slot,
				status: "conflicting",
				// Preserve the audited correction for final-report consumers; status,
				// rather than bestValue presence, remains the coverage authority.
				bestValue:
					corrections.join(" | ") ||
					"Verifier evidence conflicts with the normalized value; see claim ledger.",
				gapReason: slot.gapReason ? `${slot.gapReason}; ${reason}` : reason,
			};
		}
		// 2026-11-10 (owner; P3 hard claims): a claim the verifier did not verify but corrected means part of what the
		// slot holds is wrong; verified claims on other aspects of the slot do not settle that. The slot stays
		// partial with the correction in its gap reason (bestValue is the normalizer's and may carry the wrong part).
		const corrected = claims.filter(
			(claim) =>
				["partially_supported", "unsupported"].includes(stringOf(claim.status)) &&
				stringOf(claim.correctionOrCounterclaim)?.trim(),
		);
		if (corrected.length > 0 && slot.status === "filled") {
			const notes = compactStrings(
				corrected.map(
					(claim) =>
						`${idOf(claim) ?? "claim"}: ${claim.correctionOrCounterclaim.trim()}`,
				),
				4,
			);
			const reason = `verifier correction on a claim it did not verify (${notes.join(" | ")})`;
			return {
				...slot,
				status: "partial",
				gapReason: slot.gapReason ? `${slot.gapReason}; ${reason}` : reason,
			};
		}
		if (
			!statuses.has("verified") &&
			slot.status === "filled" &&
			["partially_supported", "unsupported", "verification_blocked"].some(
				(status) => statuses.has(status),
			)
		) {
			const reason = `no audited verified claim${claimIds.length ? ` (${claimIds.join(", ")})` : ""}`;
			return {
				...slot,
				status: "partial",
				gapReason: slot.gapReason ? `${slot.gapReason}; ${reason}` : reason,
			};
		}
		return slot;
	});
	return {
		factSlots: reconciledFactSlots,
		reconciliation: {
			source: "canonical normalized claim factSlotIds",
			addedReverseBindings,
			preservedReverseBindings,
			invalidCanonicalMemberships,
		},
	};
}

// K1 (2026-11-08): a slot the input packet found contested (same entity, different date or number
// across research observations) stays `conflicting` unless a verified audited claim on that slot
// states one of the competing values; that claim resolves it. A normalizer that marked the slot
// filled, or a verifier that verified a claim about another aspect of the slot, does not.
function reconcileContestedSlots(factSlots, claimDigests, slotConflicts) {
	// Review 2026-11-09 (gpt-6-astra, claude-fable-5-1) and re-review: the claims that bear on a contest are
	// the verified claims on its slot that name its entity (short names allowed; plan slot entities are
	// not aliases). One that states several incompatible values ("May 2021, not May 2022") keeps the contest
	// open, as do claims settling on different values; compatible precisions ("2021", "2021-05") are one.
	const conflicts = asArray(slotConflicts?.conflicts).filter(
		(conflict) => stringOf(conflict?.slotId) && Array.isArray(conflict?.values),
	);
	if (conflicts.length === 0) return { factSlots, contestedSlots: [] };
	const contestedSlots = conflicts.map((conflict) => {
		const entity = stringOf(conflict.entity);
		const bearing = claimDigests
			.filter(
				(claim) =>
					stringOf(claim.status) === "verified" &&
					compactStrings(claim.factSlotIds, 12).includes(conflict.slotId) &&
					(!entity || textNamesEntity(claim.claim, entity, 1)),
			)
			.map((claim) => ({
				claimId: idOf(claim),
				claim: stringOf(claim.claim),
				stated: collapseCompatibleValues(conflict.aspect, valuesStatedBy(conflict, claim.claim)),
			}))
			.filter((row) => row.claimId && row.stated.length > 0);
		const ambiguous = bearing.filter((row) => row.stated.length > 1);
		const resolvers = bearing.filter((row) => row.stated.length === 1);
		const settled = collapseCompatibleValues(
			conflict.aspect,
			resolvers.flatMap((row) => row.stated),
		);
		return {
			id: stringOf(conflict.id),
			slotId: conflict.slotId,
			entity: stringOf(conflict.entity),
			aspect: stringOf(conflict.aspect),
			values: conflict.values.map((entry) => ({
				value: stringOf(entry.normalized),
				raw: compactStrings(entry.raw, 4),
				documents: compactStrings(entry.documents, 4),
				sourceTypes: compactStrings(entry.sourceTypes, 4),
				sourceUrls: compactStrings(entry.sourceUrls, 4),
				sourceRefs: compactStrings(entry.sourceRefs, 4),
				files: compactStrings(entry.files, 4),
			})),
			resolution:
				ambiguous.length > 0
					? {
							status: "unresolved",
							claimIds: bearing.map((row) => row.claimId),
							values: [],
							reason: `verified claim(s) ${ambiguous.map((row) => row.claimId).join(", ")} state several values`,
						}
					: settled.length === 1
					? {
							status: "resolved_by_verified_claim",
							claimIds: resolvers.map((row) => row.claimId),
							values: settled,
							settlingClaim: resolvers[0].claim,
						}
					: settled.length > 1
						? {
								status: "unresolved",
								claimIds: resolvers.map((row) => row.claimId),
								values: [],
								reason: `verified claims state different values (${settled.join(", ")})`,
							}
						: { status: "unresolved", claimIds: [], values: [] },
		};
	});
	const unresolvedBySlot = new Map();
	for (const contested of contestedSlots) {
		if (contested.resolution.status !== "unresolved") continue;
		const rows = unresolvedBySlot.get(contested.slotId) ?? [];
		rows.push(contested);
		unresolvedBySlot.set(contested.slotId, rows);
	}
	const resolvedBySlot = new Map();
	for (const contested of contestedSlots) {
		if (contested.resolution.status !== "resolved_by_verified_claim") continue;
		const rows = resolvedBySlot.get(contested.slotId) ?? [];
		rows.push(contested);
		resolvedBySlot.set(contested.slotId, rows);
	}
	const slotClaimStatuses = new Map();
	for (const claim of claimDigests)
		for (const slotId of compactStrings(claim.factSlotIds, 12)) {
			const statuses = slotClaimStatuses.get(slotId) ?? new Set();
			statuses.add(stringOf(claim.status));
			slotClaimStatuses.set(slotId, statuses);
		}
	return {
		contestedSlots,
		factSlots: factSlots.map((slot) => {
			const unresolved = unresolvedBySlot.get(slot.slotId);
			// 2026-11-08 (L4 live): the normalizer marks a contested slot conflicting as instructed; when
			// every contest on it was settled by a verified claim and no audited claim on the slot is
			// conflicting, the slot is filled with the settled value(s) instead of staying conflicting.
			const resolved = resolvedBySlot.get(slot.slotId);
			// Review 2026-11-09: a bestValue stating a value the resolution rejected is replaced by the
			// settling claim's text — for every resolved slot, whatever status the normalizer gave it.
			const stale = unresolved
				? undefined
				: resolved?.find(
					(row) =>
						typeof slot.bestValue === "string" &&
						valuesStatedBy(
							{
								...row,
								values: row.values
									.filter((entry) => !row.resolution.values.includes(entry.value))
									.map((entry) => ({ normalized: entry.value })),
							},
							slot.bestValue,
						).length > 0,
				);
			const bestValueFix = stale?.resolution.settlingClaim
				? {
						bestValue: stale.resolution.settlingClaim,
						note: `bestValue replaced by ${stale.resolution.claimIds[0]} (it stated a rejected value)`,
					}
				: undefined;
			if (
				!unresolved &&
				resolved &&
				slot.status === "conflicting" &&
				!slotClaimStatuses.get(slot.slotId)?.has("conflicting")
			) {
				const note = `contested ${resolved
					.map(
						(row) =>
							`${row.aspect} for ${row.entity || "the slot entity"} settled to ${row.resolution.values.join(", ")} by ${row.resolution.claimIds.join(", ")} (${row.id}; other value(s): ${row.values
								.map((entry) => entry.value)
								.filter((value) => !row.resolution.values.includes(value))
								.join(", ")})`,
					)
					.join("; ")}`;
				return {
					...slot,
					status: "filled",
					...(bestValueFix ? { bestValue: bestValueFix.bestValue } : {}),
					gapReason: [slot.gapReason, note, bestValueFix?.note]
						.filter(Boolean)
						.join("; "),
				};
			}
			if (!unresolved)
				return bestValueFix
					? {
							...slot,
							bestValue: bestValueFix.bestValue,
							gapReason: [slot.gapReason, bestValueFix.note].filter(Boolean).join("; "),
						}
					: slot;
			const reason = `contested ${unresolved
				.map(
					(row) =>
						`${row.aspect} for ${row.entity || "the slot entity"}: ${row.values
							.map((entry) => entry.value)
							.join(" vs ")} (${row.id})`,
				)
				.join("; ")} not resolved by a verified claim`;
			return {
				...slot,
				status: "conflicting",
				gapReason: slot.gapReason ? `${slot.gapReason}; ${reason}` : reason,
			};
		}),
	};
}

function compactGap(gap) {
	const item = asObject(gap);
	return {
		id: stringOf(item.id ?? item.gapId),
		claimId: stringOf(item.claimId),
		slotId: stringOf(item.slotId),
		evidenceState: stringOf(item.evidenceState),
		reason: stringOf(item.reason ?? item.gapReason),
		nextStep: stringOf(item.nextStep),
		sourceUrls: compactStrings(item.sourceUrls, Infinity),
		sourceRefs: compactStrings(item.sourceRefs, Infinity),
		relatedFactSlotIds: compactStrings(item.relatedFactSlotIds, 8),
		scopeItem: stringOf(item.scopeItem),
		whyItMatters: stringOf(item.whyItMatters),
	};
}

function compactVerifierIssue(issue) {
	const item = asObject(issue);
	return {
		sourceId: stringOf(item.sourceId),
		claimId: stringOf(item.claimId),
		reason: stringOf(item.reason),
		status: stringOf(item.status),
		nextStep: stringOf(item.nextStep),
	};
}

function compactInvalidNormalizedCandidate(row) {
	const item = asObject(row);
	return {
		index: Number.isSafeInteger(Number(item.index))
			? Number(item.index)
			: undefined,
		claimId: stringOf(item.claimId),
		reason: stringOf(item.reason),
		nextStep: stringOf(item.nextStep),
	};
}

function compactOwner(owner) {
	const item = asObject(owner);
	return {
		source: stringOf(item.source),
		stageId: stringOf(item.stageId),
		specId: stringOf(item.specId),
		taskId: stringOf(item.taskId),
		itemIdentity: stringOf(item.itemIdentity),
		placeholderSpecId: stringOf(item.placeholderSpecId),
		...(stringOf(item.batchId) ? { batchId: stringOf(item.batchId) } : {}),
		status: stringOf(item.status),
	};
}

function compactDuplicateVerifierRow(row) {
	const item = asObject(row);
	return {
		claimId: stringOf(item.claimId),
		rowCount: Number.isFinite(Number(item.rowCount))
			? Number(item.rowCount)
			: undefined,
		sourceIds: compactStrings(item.sourceIds, 8),
		statusInputs: compactStrings(item.statusInputs, 8),
		selectedStatus: stringOf(item.selectedStatus),
		statusConflict: item.statusConflict === true,
		sourceRefs: compactStrings(item.sourceRefs, Infinity),
		sourceUrls: compactStrings(item.sourceUrls, Infinity),
		action: stringOf(item.action),
	};
}

function compactReadinessBlocker(blocker) {
	const item = asObject(blocker);
	return {
		reason: stringOf(item.reason),
		count: Number.isFinite(Number(item.count)) ? Number(item.count) : undefined,
	};
}

function compactBatchAdoptionReadiness(readiness) {
	const item = asObject(readiness);
	const blockers = asArray(item.blockers).map(compactReadinessBlocker);
	if (!stringOf(item.status) && blockers.length === 0) return {};
	return {
		status: stringOf(item.status),
		...(typeof item.adopted === "boolean" ? { adopted: item.adopted } : {}),
		...(typeof item.canaryRequired === "boolean"
			? { canaryRequired: item.canaryRequired }
			: {}),
		reason: stringOf(item.reason),
		blockers,
	};
}

function countByStatus(slots) {
	const counts = {};
	for (const slot of slots) {
		const status = stringOf(slot.status) ?? "unknown";
		counts[status] = (counts[status] ?? 0) + 1;
	}
	return counts;
}

function withGeneratedIds(items, prefix) {
	return items.map((item, index) => ({
		...item,
		id: stringOf(item.id) ?? `${prefix}-${String(index + 1).padStart(3, "0")}`,
	}));
}

export default async function finalAuditPacket({ sources }) {
	const plan = asObject(findSource(sources, "plan"));
	const normalizeClaims = asObject(findSource(sources, "normalize-claims"));
	const sanitizedCandidates = asObject(findSource(sources, "sanitize-claims"));
	const normalized =
		Object.keys(sanitizedCandidates).length > 0
			? sanitizedCandidates
			: normalizeClaims;
	const sanitizerDiagnostics = asObject(normalized.sanitizerDiagnostics);
	const auditSource = findSource(sources, "audit-claims");
	if (
		!auditSource ||
		typeof auditSource !== "object" ||
		Array.isArray(auditSource)
	) {
		throw new Error(
			"deep-research final-audit-packet: missing audit-claims control source; refusing to emit an empty packet",
		);
	}
	const audit = auditSource;
	const inputPacket = asObject(findSource(sources, "normalize-input-packet"));
	const questionCoverageInput = inputPacket.packet?.researchQuestionCoverage;
	const researchQuestionCoverage =
		questionCoverageInput &&
		typeof questionCoverageInput === "object" &&
		!Array.isArray(questionCoverageInput) &&
		typeof questionCoverageInput.passed === "boolean"
			? questionCoverageInput
			: null;
	// These fields establish that the audit stage actually ran and produced an
	// auditable ledger. Do not turn an absent/incomplete audit into a valid empty packet.
	const incompleteAuditFields = [
		["claimDigests", Array.isArray(audit.claimDigests)],
		[
			"gateSummary",
			audit.gateSummary &&
				typeof audit.gateSummary === "object" &&
				!Array.isArray(audit.gateSummary),
		],
	]
		.filter(([, present]) => !present)
		.map(([field]) => field);
	const hasAuditLedger =
		Object.keys(audit.gateSummary ?? {}).length > 0 ||
		(audit.verdictCounts &&
			typeof audit.verdictCounts === "object" &&
			!Array.isArray(audit.verdictCounts) &&
			Object.keys(audit.verdictCounts).length > 0) ||
		(audit.statusPartitions &&
			typeof audit.statusPartitions === "object" &&
			!Array.isArray(audit.statusPartitions) &&
			Object.keys(audit.statusPartitions).length > 0);
	if (
		incompleteAuditFields.length === 0 &&
		audit.claimDigests.length === 0 &&
		!hasAuditLedger
	)
		incompleteAuditFields.push("audit ledgers");
	if (incompleteAuditFields.length > 0) {
		throw new Error(
			`deep-research final-audit-packet: incomplete audit-claims control (${incompleteAuditFields.join(", ")}); refusing to emit a valid empty packet`,
		);
	}
	const claimInventory = asObject(normalized.claimInventory);
	const verificationCandidates = asArray(claimInventory.verificationCandidates);
	const preservedClaims = asArray(claimInventory.preservedClaims);
	const auditedClaimsById = new Map(
		asArray(audit.auditedClaims)
			.map((claim) => [idOf(claim), claim])
			.filter(([id]) => id),
	);
	const claimDigests = asArray(audit.claimDigests).map((digest) => {
		const audited = auditedClaimsById.get(idOf(digest));
		return compactClaimDigest({
			...digest,
			...(audited?.evidence ? { evidence: audited.evidence } : {}),
			...(Array.isArray(audited?.localQuoteGate)
				? { localQuoteGate: audited.localQuoteGate }
				: {}),
		});
	});
	const auditedIds = new Set(claimDigests.map(idOf).filter(Boolean));
	const candidateIds = verificationCandidates.map(idOf).filter(Boolean);
	const omittedCandidateIds = candidateIds.filter((id) => !auditedIds.has(id));
	const factSlotReconciliation = reconcileFactSlotCoverageWithAudit(
		asArray(normalized.factSlotCoverage).map(compactSlot),
		claimDigests,
		candidateIds,
	);
	const contestedReconciliation = reconcileContestedSlots(
		factSlotReconciliation.factSlots,
		claimDigests,
		inputPacket.packet?.slotConflicts,
	);
	const factSlotCoverage = contestedReconciliation.factSlots;
	const contestedSlots = contestedReconciliation.contestedSlots;
	const coverageGaps = withGeneratedIds(
		asArray(normalized.coverageGaps).map(compactGap),
		"gap-coverage",
	);
	const remainingGaps = withGeneratedIds(
		asArray(audit.remainingGaps).map(compactGap),
		"gap-remaining",
	);
	const sourceRefJoinFailures = withGeneratedIds(
		asArray(audit.sourceRefJoinFailures).map(compactGap),
		"gap-source-ref",
	);
	const invalidVerifierRows = asArray(audit.invalidVerifierRows).map(
		compactVerifierIssue,
	);
	const duplicateVerifierRows = asArray(audit.duplicateVerifierRows).map(
		compactDuplicateVerifierRow,
	);
	const invalidNormalizedCandidateRows = asArray(
		audit.invalidNormalizedCandidates,
	).map(compactInvalidNormalizedCandidate);
	const verifierOwnerLedger = asArray(audit.verifierOwnerLedger).map(
		compactOwner,
	);
	const verifierOwnerIssues = asArray(audit.verifierOwnerIssues).map(
		compactVerifierIssue,
	);
	const gateSummary = asObject(audit.gateSummary);
	const batchAdoptionReadiness = compactBatchAdoptionReadiness(
		audit.batchAdoptionReadiness,
	);
	const zeroCandidateFloorBlockerInput = Number(
		gateSummary.zeroCandidateFloorBlockers ?? 0,
	);
	const zeroCandidateFloorBlockers = Number.isFinite(
		zeroCandidateFloorBlockerInput,
	)
		? zeroCandidateFloorBlockerInput
		: 0;
	const precisionGuardDiagnostics = asObject(audit.precisionGuardDiagnostics);
	const sourceRefCoverage = {
		verificationCandidatesWithSourceRefs: verificationCandidates.filter(
			(candidate) => compactStrings(candidate?.sourceRefs, 1).length > 0,
		).length,
		auditedClaimsWithSourceRefs: claimDigests.filter(
			(claim) => compactStrings(claim?.sourceRefs, 1).length > 0,
		).length,
		sourceRefJoinFailures: sourceRefJoinFailures.length,
	};

	const result = {
		schema: SCHEMA,
		digest: `Prepared final-audit packet with ${claimDigests.length} audited claim(s), ${factSlotCoverage.length} fact slot(s), and ${remainingGaps.length + coverageGaps.length + sourceRefJoinFailures.length} gap row(s).`,
		packet: {
			researchMetadataSeed: {
				depth: stringOf(plan.depth),
				taskType: stringOf(plan.taskType),
				expectedFinalShape: stringOf(plan.expectedFinalShape),
				researchQuestions: asArray(plan.researchQuestions).length,
				sourcePolicy: asObject(plan.sourcePolicy),
				plannedFactSlots: asArray(plan.factSlots).length,
				filledFactSlots: factSlotCoverage.filter((slot) => slot.status === "filled")
					.length,
				partialFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "partial",
				).length,
				missingOnlyFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "missing",
				).length,
				// Keep the legacy unresolved total backward-complete. The explicit
				// fields make its overlap with conflictingFactSlots machine-readable.
				missingFactSlots: factSlotCoverage.filter((slot) =>
					["missing", "conflicting"].includes(slot.status),
				).length,
				missingFactSlotsIncludesConflicting: true,
				conflictingFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "conflicting",
				).length,
			},
			verdictCounts: asObject(audit.verdictCounts),
			statusPartitions: asObject(audit.statusPartitions),
			factSlotCoverage,
			factSlotStatusCounts: countByStatus(factSlotCoverage),
			coverageGaps,
			remainingGaps,
			sourceRefJoinFailures,
			contestedSlots,
			claimVerdictLedger: claimDigests,
			verifierIntegrity: {
				gateSummary,
				researchQuestionIntegrity: researchQuestionCoverage,
				invalidVerifierRows,
				duplicateVerifierRows,
				invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
				invalidNormalizedCandidateRows,
				verifierOwnerLedger,
				verifierOwnerIssues,
				...(stringOf(batchAdoptionReadiness.status)
					? { batchAdoptionReadiness }
					: {}),
			},
			normalizerDiagnostics: {
				precisionGuard: precisionGuardDiagnostics,
				sanitizer: sanitizerDiagnostics,
			},
			preservedClaims: preservedClaims.map((claim) => ({
				id: idOf(claim),
				claim: stringOf(claim.claim),
				factSlotIds: compactStrings(claim.factSlotIds, 8),
				sourceRefs: compactStrings(claim.sourceRefs, Infinity),
				sourceUrls: compactStrings(claim.sourceUrls, Infinity),
				whyItMatters: stringOf(claim.whyItMatters ?? claim.reason),
			})),
			researchScopeCoverage: asArray(normalized.researchScopeCoverage),
			researchQuestionCoverage: asArray(researchQuestionCoverage?.rows),
			factSlotReconciliation: {
				...factSlotReconciliation.reconciliation,
				contestedSlotIds: [...new Set(contestedSlots.map((row) => row.slotId))],
				unresolvedContestedSlotIds: [
					...new Set(
						contestedSlots
							.filter((row) => row.resolution.status === "unresolved")
							.map((row) => row.slotId),
					),
				],
			},
			invariantChecks: {
				candidateCount: verificationCandidates.length,
				factSlotReconciliation: factSlotReconciliation.reconciliation,
				auditedClaimCount: claimDigests.length,
				candidateIds,
				auditedClaimIds: claimDigests.map(idOf),
				statusPartitionIds: asObject(audit.statusPartitions),
				omittedCandidateIds,
				droppedSlotIds: asArray(audit.slotCoverageCheck?.droppedSlotIds),
				researchQuestionIntegrity: researchQuestionCoverage,
				sourceRefCoverage,
				verifierIntegrity: {
					invalidVerifierRows: invalidVerifierRows.length,
					researchQuestionIntegrity: researchQuestionCoverage,
					duplicateVerifierRows: duplicateVerifierRows.length,
					invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
					verifierOwnerIssues: verifierOwnerIssues.length,
					missingVerifierResults: Number(gateSummary.missingVerifierResults ?? 0),
					zeroCandidateFloorBlockers,
					batchAdoptionStatus: stringOf(batchAdoptionReadiness.status),
				},
			},
			overflowLedger: {
				preservedClaimCount: preservedClaims.length,
				coverageGapCount: coverageGaps.length,
				remainingGapCount: remainingGaps.length,
				omittedVerificationCandidateCount: omittedCandidateIds.length,
				invalidVerifierRowCount: invalidVerifierRows.length,
				duplicateVerifierRowCount: duplicateVerifierRows.length,
				invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
				verifierOwnerIssueCount: verifierOwnerIssues.length,
			},
		},
	};
	result.packet.synthesisInput = buildSynthesisPages(result.packet);
	return result;
}
