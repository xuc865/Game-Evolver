from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from game_loop.utils import atomic_write_json, read_json, utc_now

if TYPE_CHECKING:
    from game_loop.config import HarnessElementConfig
    from game_loop.core.harness import (
        HarnessActiveElement,
        HarnessEpochResult,
        HarnessProfile,
    )

ELEMENT_CATEGORIES = frozenset({
    "skill",
    "mcp",
    "tool",
    "context",
    "protocol",
    "workflow",
    "dsh_plugin",
    "subagent",
})

CATEGORY_ALIASES: dict[str, str] = {
    "skills": "skill",
    "skill_governance": "skill",
    "mcp_server": "mcp",
    "tool_interface": "tool",
    "context_compiler": "context",
    "workflow_planner": "workflow",
    "usage_driven": "skill",
    "plugin": "dsh_plugin",
    "plugins": "dsh_plugin",
    "cordis": "dsh_plugin",
    "cordis_plugin": "dsh_plugin",
    "child_agent": "subagent",
    "fork_agent": "subagent",
    "subagent_prototype": "subagent",
}

DEFAULT_ELEMENT_MUTATION_POLICY: dict[str, Any] = {
    "removal_min_usage": 5,
    "removal_min_usage_share": 0.25,
    "removal_max_accuracy": 0.35,
    "modify_min_usage": 3,
    "modify_max_accuracy": 0.55,
    "merge_min_similarity": 0.55,
    "merge_similarity_override": 0.75,
}


@dataclass(frozen=True)
class ElementMutationResult:
    active: list["HarnessActiveElement"]
    catalog_additions: tuple["HarnessElementConfig", ...] = ()
    operation: str = "none"


@dataclass
class ElementStat:
    element_id: str
    category: str
    usage_count: int = 0
    success_count: int = 0
    score_count: int = 0
    score_total: float = 0.0
    score_sum_squares: float = 0.0
    hard_regression_ever: bool = False
    hard_regression_count: int = 0
    attributed_inner_epochs: list[int] = field(default_factory=list)

    @property
    def accuracy(self) -> float:
        if self.usage_count <= 0:
            return 0.0
        return self.success_count / self.usage_count

    @property
    def score_mean(self) -> float | None:
        if self.score_count <= 0:
            return None
        return self.score_total / self.score_count

    @property
    def score_variance(self) -> float | None:
        if self.score_count <= 0:
            return None
        mean = self.score_total / self.score_count
        return max(0.0, self.score_sum_squares / self.score_count - mean * mean)

    def to_dict(self) -> dict[str, Any]:
        return {
            "element_id": self.element_id,
            "category": self.category,
            "usage_count": self.usage_count,
            "success_count": self.success_count,
            "accuracy": self.accuracy,
            "score_count": self.score_count,
            "score_total": self.score_total,
            "score_sum_squares": self.score_sum_squares,
            "score_mean": self.score_mean,
            "score_variance": self.score_variance,
            "hard_regression_ever": self.hard_regression_ever,
            "hard_regression_count": self.hard_regression_count,
            "attributed_inner_epochs": list(self.attributed_inner_epochs),
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ElementStat":
        score_count = int(value.get("score_count", 0))
        score_total = float(value.get("score_total", 0.0))
        raw_sum_squares = value.get("score_sum_squares")
        if raw_sum_squares is None and score_count > 0:
            mean = score_total / score_count
            variance = float(value.get("score_variance", 0.0) or 0.0)
            score_sum_squares = score_count * (variance + mean * mean)
        else:
            score_sum_squares = float(raw_sum_squares or 0.0)
        return cls(
            element_id=str(value["element_id"]),
            category=str(value.get("category", "skill")),
            usage_count=int(value.get("usage_count", 0)),
            success_count=int(value.get("success_count", 0)),
            score_count=score_count,
            score_total=score_total,
            score_sum_squares=score_sum_squares,
            hard_regression_ever=bool(value.get("hard_regression_ever", False)),
            hard_regression_count=int(value.get("hard_regression_count", 0)),
            attributed_inner_epochs=sorted({
                int(item) for item in value.get("attributed_inner_epochs", [])
            }),
        )


def element_stat_key(category: str, element_id: str) -> str:
    return f"{category}:{element_id}"


def inner_harness_score_and_hard_regression(
    result: "HarnessEpochResult",
) -> tuple[float | None, bool]:
    """Return the aggregate candidate soft score and any paired hard regression."""

    validation = result.rubric_validation or {}
    overall_infrastructure = validation.get("infrastructure_ok")
    if overall_infrastructure is not None and overall_infrastructure is not True:
        return None, False
    if any(
        not outcome.infrastructure_ok
        for outcome in (*result.parent_outcomes, *result.candidate_outcomes)
    ):
        return None, False
    candidate_soft_scores: list[float] = []
    hard_regression = False
    for case in validation.get("case_results", []):
        if not isinstance(case, dict):
            continue
        parent = case.get("parent", {})
        candidate = case.get("candidate", {})
        if not isinstance(parent, dict) or not isinstance(candidate, dict):
            continue
        for side in (parent, candidate):
            infrastructure_ok = side.get("infrastructure_ok")
            if infrastructure_ok is not None and infrastructure_ok is not True:
                return None, False
        soft_total = candidate.get("soft_total")
        if isinstance(soft_total, (int, float)):
            candidate_soft_scores.append(float(soft_total))
        parent_hard = parent.get("hard", {})
        candidate_hard = candidate.get("hard", {})
        if isinstance(parent_hard, dict) and isinstance(candidate_hard, dict):
            for rubric_id, parent_value in parent_hard.items():
                candidate_value = candidate_hard.get(rubric_id)
                if (
                    isinstance(parent_value, (int, float))
                    and isinstance(candidate_value, (int, float))
                    and float(candidate_value) < float(parent_value)
                ):
                    hard_regression = True
                    break

    if not hard_regression:
        hard_regression = any(
            "hard rubric" in str(reason).casefold()
            and any(token in str(reason).casefold() for token in ("regress", "decreas", "dropped"))
            for reason in result.reasons
        )
    if candidate_soft_scores:
        return sum(candidate_soft_scores), hard_regression

    fallback_scores = [
        float(outcome.final_score)
        for outcome in result.candidate_outcomes
        if outcome.infrastructure_ok and outcome.final_score is not None
    ]
    return (sum(fallback_scores) if fallback_scores else None), hard_regression


def _policy_value(policy: dict[str, Any], key: str) -> Any:
    return policy.get(key, DEFAULT_ELEMENT_MUTATION_POLICY[key])


def element_similarity(
    left: "HarnessElementConfig",
    right: "HarnessElementConfig",
) -> float:
    if left.category != right.category:
        return 0.0
    tags_left = {tag.casefold() for tag in left.tags}
    tags_right = {tag.casefold() for tag in right.tags}
    union = tags_left | tags_right
    tag_sim = len(tags_left & tags_right) / max(1, len(union))
    keys_left = set(left.spec.keys())
    keys_right = set(right.spec.keys())
    key_union = keys_left | keys_right
    spec_sim = len(keys_left & keys_right) / max(1, len(key_union))
    return 0.65 * tag_sim + 0.35 * spec_sim


@dataclass
class HarnessElementStatsStore:
    """Usage/accuracy stats for concrete catalog elements (skills, MCPs, tools, ...)."""

    root: str
    items: dict[str, ElementStat] = field(default_factory=dict)
    updated_at: str = field(default_factory=utc_now)

    @classmethod
    def load(cls, path) -> "HarnessElementStatsStore":
        from pathlib import Path

        file_path = Path(path)
        if not file_path.is_file():
            return cls(root=str(file_path.parent))
        raw = read_json(file_path)
        items = {
            key: ElementStat.from_dict(value)
            for key, value in dict(raw.get("items", {})).items()
        }
        return cls(
            root=str(file_path.parent),
            items=items,
            updated_at=str(raw.get("updated_at", utc_now())),
        )

    def save(self, path) -> None:
        from pathlib import Path

        file_path = Path(path)
        self.updated_at = utc_now()
        atomic_write_json(
            file_path,
            {
                "schema_version": "harness-element-stats.v2",
                "updated_at": self.updated_at,
                "items": {key: item.to_dict() for key, item in self.items.items()},
            },
        )

    def touch(
        self,
        *,
        category: str,
        element_id: str,
        success: bool,
        score: float | None = None,
        hard_regression: bool = False,
        attribution_epoch: int | None = None,
    ) -> bool:
        key = element_stat_key(category, element_id)
        stat = self.items.get(key)
        if stat is None:
            stat = ElementStat(element_id=element_id, category=category)
            self.items[key] = stat
        if (
            attribution_epoch is not None
            and attribution_epoch in stat.attributed_inner_epochs
        ):
            return False
        stat.usage_count += 1
        if success:
            stat.success_count += 1
        if score is not None:
            numeric_score = float(score)
            stat.score_count += 1
            stat.score_total += numeric_score
            stat.score_sum_squares += numeric_score * numeric_score
        if hard_regression:
            stat.hard_regression_ever = True
            stat.hard_regression_count += 1
        if attribution_epoch is not None:
            stat.attributed_inner_epochs.append(attribution_epoch)
            stat.attributed_inner_epochs.sort()
        return True

    def record_epoch(
        self,
        *,
        profile: "HarnessProfile",
        result: "HarnessEpochResult",
    ) -> None:
        success = result.accepted
        score, hard_regression = inner_harness_score_and_hard_regression(result)
        for element in profile.active_elements:
            self.touch(
                category=element.category,
                element_id=element.element_id,
                success=success,
                score=score,
                hard_regression=hard_regression,
            )

    def active_in_category(
        self,
        active: list["HarnessActiveElement"],
        category: str,
    ) -> list["HarnessActiveElement"]:
        return [item for item in active if item.category == category]

    def category_usage_total(
        self,
        active: list["HarnessActiveElement"],
        category: str,
    ) -> int:
        total = 0
        for element in self.active_in_category(active, category):
            stat = self.items.get(element_stat_key(category, element.element_id))
            if stat is not None:
                total += stat.usage_count
        return total

    def usage_share(
        self,
        *,
        active: list["HarnessActiveElement"],
        category: str,
        element_id: str,
    ) -> float:
        total = self.category_usage_total(active, category)
        if total <= 0:
            return 0.0
        stat = self.items.get(element_stat_key(category, element_id))
        if stat is None:
            return 0.0
        return stat.usage_count / total

    def removal_target(
        self,
        active: list["HarnessActiveElement"],
        category: str,
        *,
        policy: dict[str, Any] | None = None,
    ) -> str | None:
        """Only remove elements with high usage share AND low accuracy."""
        policy = policy or DEFAULT_ELEMENT_MUTATION_POLICY
        min_usage = int(_policy_value(policy, "removal_min_usage"))
        min_share = float(_policy_value(policy, "removal_min_usage_share"))
        max_accuracy = float(_policy_value(policy, "removal_max_accuracy"))
        total = self.category_usage_total(active, category)
        if total <= 0:
            return None
        ranked: list[tuple[float, float, str]] = []
        for element in self.active_in_category(active, category):
            stat = self.items.get(element_stat_key(category, element.element_id))
            if stat is None:
                continue
            share = stat.usage_count / total
            if (
                stat.usage_count >= min_usage
                and share >= min_share
                and stat.accuracy <= max_accuracy
            ):
                ranked.append((stat.accuracy, -share, element.element_id))
        if not ranked:
            return None
        ranked.sort()
        return ranked[0][2]

    def modify_target(
        self,
        active: list["HarnessActiveElement"],
        category: str,
        *,
        policy: dict[str, Any] | None = None,
    ) -> str | None:
        policy = policy or DEFAULT_ELEMENT_MUTATION_POLICY
        min_usage = int(_policy_value(policy, "modify_min_usage"))
        max_accuracy = float(_policy_value(policy, "modify_max_accuracy"))
        ranked: list[tuple[float, str]] = []
        for element in self.active_in_category(active, category):
            stat = self.items.get(element_stat_key(category, element.element_id))
            if stat is None:
                continue
            if stat.usage_count >= min_usage and stat.accuracy < max_accuracy:
                ranked.append((stat.accuracy, element.element_id))
        if not ranked:
            return None
        ranked.sort()
        return ranked[0][1]

    def addition_target(
        self,
        catalog: dict[str, "HarnessElementConfig"],
        active: list["HarnessActiveElement"],
        category: str,
        *,
        preferred_tags: tuple[str, ...] = (),
    ) -> str | None:
        active_ids = {item.element_id for item in self.active_in_category(active, category)}
        candidates = [
            spec
            for spec in catalog.values()
            if spec.category == category and spec.element_id not in active_ids
        ]
        if not candidates:
            return None
        normalized = {tag.casefold() for tag in preferred_tags}
        explicit_ids = {
            tag.split(":", 1)[1]
            for tag in preferred_tags
            if tag.casefold().startswith("element_id:") and ":" in tag
        }
        if explicit_ids:
            explicit = sorted(
                spec.element_id
                for spec in candidates
                if spec.element_id in explicit_ids
            )
            if explicit:
                return explicit[0]

        # Category/control tags do not describe benchmark compatibility.
        ignored = ELEMENT_CATEGORIES | {
            "usage_driven", "element_add", "element_remove", "element_modify",
            "element_merge", "text_only",
        }
        affinity_tags = normalized - ignored
        scored: list[tuple[int, int, float, str]] = []
        for spec in candidates:
            stat = self.items.get(element_stat_key(category, spec.element_id))
            accuracy = stat.accuracy if stat and stat.usage_count > 0 else 0.55
            spec_tags = {tag.casefold() for tag in spec.tags}
            exact_affinity = len(spec_tags & affinity_tags)
            universal = 1 if "universal" in spec_tags else 0
            scored.append((exact_affinity, universal, accuracy, spec.element_id))
        scored.sort(reverse=True)
        return scored[0][3]

    def merge_target(
        self,
        catalog: dict[str, "HarnessElementConfig"],
        active: list["HarnessActiveElement"],
        category: str,
        *,
        policy: dict[str, Any] | None = None,
        force_merge: bool = False,
    ) -> tuple[str, str] | None:
        policy = policy or DEFAULT_ELEMENT_MUTATION_POLICY
        min_similarity = float(_policy_value(policy, "merge_min_similarity"))
        override_similarity = float(_policy_value(policy, "merge_similarity_override"))
        current = self.active_in_category(active, category)
        if len(current) < 2:
            return None
        best: tuple[float, str, str] | None = None
        for index, left in enumerate(current):
            left_spec = catalog.get(left.element_id)
            if left_spec is None:
                continue
            for right in current[index + 1 :]:
                right_spec = catalog.get(right.element_id)
                if right_spec is None:
                    continue
                similarity = element_similarity(left_spec, right_spec)
                threshold = override_similarity if force_merge else min_similarity
                if similarity < threshold:
                    continue
                left_stat = self.items.get(element_stat_key(category, left.element_id))
                right_stat = self.items.get(element_stat_key(category, right.element_id))
                combined_usage = (left_stat.usage_count if left_stat else 0) + (
                    right_stat.usage_count if right_stat else 0
                )
                left_acc = left_stat.accuracy if left_stat else 0.0
                right_acc = right_stat.accuracy if right_stat else 0.0
                avg_acc = (left_acc + right_acc) / 2.0
                score = similarity + combined_usage * 0.01 - avg_acc
                if best is None or score > best[0]:
                    best = (score, left.element_id, right.element_id)
        if best is None:
            return None
        return best[1], best[2]


def compose_merged_element(
    *,
    left: "HarnessElementConfig",
    right: "HarnessElementConfig",
) -> "HarnessElementConfig":
    from game_loop.config import HarnessElementConfig

    merged_tags = tuple(sorted({*left.tags, *right.tags}))
    merged_spec = {
        **left.spec,
        **right.spec,
        "merged_from": [left.element_id, right.element_id],
    }
    digest = hashlib.sha256(
        f"{left.element_id}:{right.element_id}:{merged_tags}".encode("utf-8")
    ).hexdigest()[:10]
    element_id = f"{left.category}_merged_{digest}"
    description = (
        f"Merged element combining {left.element_id} and {right.element_id}: "
        f"{left.description[:80]} | {right.description[:80]}"
    )[:2000]
    return HarnessElementConfig(
        element_id=element_id,
        category=left.category,
        description=description,
        spec=merged_spec,
        tags=merged_tags,
    )


def compose_derived_element(
    *,
    base: "HarnessElementConfig",
    category: str,
    suffix: str,
) -> "HarnessElementConfig":
    from game_loop.config import HarnessElementConfig

    digest = hashlib.sha256(f"{base.element_id}:{suffix}".encode("utf-8")).hexdigest()[:10]
    element_id = f"{category}_derived_{digest}"
    description = f"Derived from {base.element_id}: {base.description}"[:2000]
    spec = {**base.spec, "derived_from": base.element_id, "variant": suffix}
    return HarnessElementConfig(
        element_id=element_id,
        category=category,
        description=description,
        spec=spec,
        tags=base.tags,
    )


def resolve_target_category(tags: tuple[str, ...]) -> str | None:
    # Preserve proposer order.  Control tags such as ``usage_driven`` must not
    # nondeterministically override an explicit category selected by the
    # proposer (set iteration previously turned workflow proposals into skill
    # mutations on some processes).
    normalized = tuple(dict.fromkeys(tag.casefold() for tag in tags))
    for tag in normalized:
        if tag in ELEMENT_CATEGORIES:
            return tag
    for tag in normalized:
        if tag in CATEGORY_ALIASES and CATEGORY_ALIASES[tag] in ELEMENT_CATEGORIES:
            return CATEGORY_ALIASES[tag]
    return None


def resolve_target_categories(tags: tuple[str, ...]) -> tuple[str, ...]:
    """Resolve all explicitly ordered element categories in a gradient."""
    categories: list[str] = []
    for tag in dict.fromkeys(item.casefold() for item in tags):
        category = tag if tag in ELEMENT_CATEGORIES else CATEGORY_ALIASES.get(tag)
        if category in ELEMENT_CATEGORIES and category not in categories:
            categories.append(category)
    return tuple(categories)


def mutate_category_elements(
    *,
    active: list["HarnessActiveElement"],
    category: str,
    catalog: dict[str, "HarnessElementConfig"],
    stats: HarnessElementStatsStore,
    limits: dict[str, int],
    gradient_tags: tuple[str, ...],
    policy: dict[str, Any] | None = None,
    allow_explicit_replacement: bool = False,
) -> ElementMutationResult | None:
    """Add/remove/merge/replace concrete elements inside one category."""
    from game_loop.core.harness import HarnessActiveElement

    if category not in ELEMENT_CATEGORIES:
        return None
    policy = policy or DEFAULT_ELEMENT_MUTATION_POLICY
    normalized_tags = {tag.casefold() for tag in gradient_tags}
    if "usage_driven" not in normalized_tags:
        return None

    limit = limits.get(category, 1)
    current = stats.active_in_category(active, category)
    force_merge = "element_merge" in normalized_tags
    force_add = bool({"element_add", "element_replace"} & normalized_tags)

    merge_pair = None if force_add else stats.merge_target(
        catalog,
        active,
        category,
        policy=policy,
        force_merge=force_merge,
    )
    if merge_pair is not None:
        left_id, right_id = merge_pair
        left_spec = catalog[left_id]
        right_spec = catalog[right_id]
        merged_spec = compose_merged_element(left=left_spec, right=right_spec)
        merged_active = HarnessActiveElement.from_config(merged_spec)
        next_active = [
            item
            for item in active
            if not (
                item.category == category
                and item.element_id in {left_id, right_id}
            )
        ]
        next_active.append(merged_active)
        return ElementMutationResult(
            active=next_active,
            catalog_additions=(merged_spec,),
            operation="merge",
        )

    remove_id = None if force_add else stats.removal_target(active, category, policy=policy)
    if remove_id is not None:
        return ElementMutationResult(
            active=[
                item
                for item in active
                if not (item.category == category and item.element_id == remove_id)
            ],
            operation="remove",
        )

    modify_id = None if force_add else stats.modify_target(active, category, policy=policy)
    if modify_id is not None:
        replacement_id = stats.addition_target(
            catalog,
            active,
            category,
            preferred_tags=gradient_tags,
        )
        if replacement_id is None:
            base = catalog.get(modify_id)
            if base is not None:
                derived = compose_derived_element(
                    base=base,
                    category=category,
                    suffix="variant",
                )
                derived_active = HarnessActiveElement.from_config(derived)
                return ElementMutationResult(
                    active=[
                        derived_active
                        if item.category == category and item.element_id == modify_id
                        else item
                        for item in active
                    ],
                    catalog_additions=(derived,),
                    operation="derive",
                )
            pool = [
                spec.element_id
                for spec in catalog.values()
                if spec.category == category and spec.element_id != modify_id
            ]
            if not pool:
                return None
            replacement_id = pool[0]
        replacement = catalog[replacement_id]
        return ElementMutationResult(
            active=[
                HarnessActiveElement.from_config(replacement)
                if item.category == category and item.element_id == modify_id
                else item
                for item in active
            ],
            operation="replace",
        )

    add_id = stats.addition_target(
        catalog,
        active,
        category,
        preferred_tags=gradient_tags,
    )
    if add_id is not None and len(current) < limit:
        return ElementMutationResult(
            active=[*active, HarnessActiveElement.from_config(catalog[add_id])],
            operation="add",
        )
    if allow_explicit_replacement and add_id is not None and current:
        explicit_ids = {
            tag.split(":", 1)[1]
            for tag in gradient_tags
            if tag.casefold().startswith("element_id:") and ":" in tag
        }
        if add_id in explicit_ids:
            replacement = HarnessActiveElement.from_config(catalog[add_id])
            removal = min(
                current,
                key=lambda item: (
                    stats.items.get(
                        element_stat_key(category, item.element_id),
                        ElementStat(item.element_id, category),
                    ).accuracy,
                    item.element_id,
                ),
            )
            return ElementMutationResult(
                active=[
                    replacement
                    if item.category == category and item.element_id == removal.element_id
                    else item
                    for item in active
                ],
                operation="replace",
            )

    if len(current) < limit:
        seed_spec = next(
            (spec for spec in catalog.values() if spec.category == category),
            None,
        )
        if seed_spec is not None:
            derived = compose_derived_element(
                base=seed_spec,
                category=category,
                suffix="evolved",
            )
            return ElementMutationResult(
                active=[*active, HarnessActiveElement.from_config(derived)],
                catalog_additions=(derived,),
                operation="compose",
            )
    return None
