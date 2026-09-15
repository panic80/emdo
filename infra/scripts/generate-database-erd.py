#!/usr/bin/env python3
"""Generate the current EMDO database ERD from the Drizzle snapshot.

The graph is deliberately sourced from the journaled Drizzle metadata.  SQL
objects that are outside that snapshot (views, policies, RLS settings and
triggers) are inventoried as behaviour metadata and are never promoted into
tables or inferred foreign-key edges.

Only Python's standard library is used so this can be rerun on a clean host:

    python3 infra/scripts/generate-database-erd.py
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
from pathlib import Path
from typing import Any


DOMAIN_ORDER = [
    "WorkspaceAccess",
    "Accounting",
    "ImportsEvidence",
    "Investments",
    "Automation",
    "Tax",
    "LegacyRuntime",
]

DOMAIN_COLORS = {
    "WorkspaceAccess": "#8b5cf6",
    "Accounting": "#0ea5e9",
    "ImportsEvidence": "#14b8a6",
    "Investments": "#f59e0b",
    "Automation": "#ec4899",
    "Tax": "#ef4444",
    "LegacyRuntime": "#64748b",
}

WORKSPACE_ACCESS_TABLES = {
    "auth_accounts",
    "auth_passkeys",
    "auth_rate_limits",
    "auth_sessions",
    "auth_users",
    "auth_verifications",
    "deployment_bootstraps",
    "disclosure_grants",
    "household_administration_commands",
    "household_memberships",
    "households",
    "invitation_delivery_secrets",
    "invitation_redemption_commands",
    "invitations",
    "rotating_sessions",
    "space_access_grants",
    "space_records",
    "spaces",
    "workspace_entitlements",
    "workspaces",
    "finance_book_grants",
}

ACCOUNTING_TABLES = {
    "finance_books",
    "finance_command_receipts",
    "finance_commercial_documents",
    "finance_commercial_lines",
    "finance_economic_transactions",
    "finance_entities",
    "finance_financial_accounts",
    "finance_generated_reports",
    "finance_journal_lines",
    "finance_journals",
    "finance_ledger_accounts",
    "finance_parties",
    "finance_payment_allocations",
    "finance_payments",
    "finance_periods",
    "finance_specialist_record_receipts",
    "finance_v2_audit",
}

IMPORTS_EVIDENCE_TABLES = {
    "finance_book_evidence",
    "finance_document_chunks",
    "finance_document_evidence",
    "finance_document_extractions",
    "finance_document_matches",
    "finance_document_review_batches",
    "finance_documents",
    "finance_import_fingerprints",
    "finance_import_plans",
    "finance_import_receipts",
    "finance_import_row_reviews",
    "finance_normalized_import_rows",
    "finance_normalized_imports",
    "finance_report_mapping_reviews",
    "finance_report_mapping_versions",
}

INVESTMENTS_TABLES = {
    "finance_fx_observations",
    "finance_instrument_identifiers",
    "finance_instruments",
    "finance_investment_corporate_action_effects",
    "finance_investment_corporate_action_lots",
    "finance_investment_corporate_actions",
    "finance_investment_lot_revisions",
    "finance_investment_lots",
    "finance_investment_movements",
    "finance_investment_openings",
    "finance_investment_prices",
    "finance_lot_allocations",
    "finance_lot_disposals",
    "finance_observed_positions",
    "finance_valuation_runs",
}

AUTOMATION_TABLES = {
    "finance_automation_authority_epochs",
    "finance_automation_capabilities",
    "finance_automation_grants",
    "finance_automation_runs",
    "finance_deliveries",
    "finance_schedule_plans",
    "finance_schedules",
    "notification_deliveries",
    "scheduler_execution_receipts",
    "scheduler_reminders",
    "worker_job_executions",
    "worker_operation_outbox",
}

TAX_TABLES = {
    "finance_tax_book_sources",
    "finance_tax_case_grants",
    "finance_tax_case_snapshots",
    "finance_tax_cases",
    "finance_tax_fact_sources",
    "finance_tax_receipts",
    "finance_tax_subjects",
}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def strip_sql_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", " ", sql)


IDENT = r"(?:\"[^\"]+\"|[A-Za-z_][A-Za-z0-9_$]*)"
QUALIFIED = rf"(?:(?:{IDENT})\s*\.\s*)?{IDENT}"


def unquote_identifier(value: str) -> str:
    value = value.strip()
    if value.startswith('"') and value.endswith('"'):
        return value[1:-1].replace('""', '"')
    return value


def normalize_ref(value: str, default_schema: str = "emdo") -> str:
    parts = [unquote_identifier(part.strip()) for part in value.split(".")]
    if len(parts) == 1:
        return f"{default_schema}.{parts[0]}"
    return f"{parts[-2]}.{parts[-1]}"


def parse_sql_inventory(root: Path, entries: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    """Inventory SQL-only behaviour without treating it as graph structure."""

    inventory: dict[str, list[dict[str, str]]] = {
        "tables": [],
        "views": [],
        "functions": [],
        "triggers": [],
        "policies": [],
        "rls": [],
        "roles": [],
    }
    patterns = {
        "tables": re.compile(
            rf"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<ref>{QUALIFIED})",
            re.IGNORECASE,
        ),
        "views": re.compile(
            rf"\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?P<ref>{QUALIFIED})",
            re.IGNORECASE,
        ),
        "functions": re.compile(
            rf"\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?P<ref>{QUALIFIED})\s*\(",
            re.IGNORECASE,
        ),
        "triggers": re.compile(
            rf"\bCREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(?P<name>{IDENT})[^;]*?\bON\s+(?P<table>{QUALIFIED})(?![\w.%])",
            re.IGNORECASE,
        ),
        "policies": re.compile(
            rf"\bCREATE\s+POLICY\s+(?P<name>{IDENT})\s+ON\s+(?P<table>{QUALIFIED})",
            re.IGNORECASE,
        ),
        "rls": re.compile(
            rf"\bALTER\s+TABLE\s+(?P<table>{QUALIFIED})\s+(?P<mode>ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY",
            re.IGNORECASE,
        ),
        "roles": re.compile(
            rf"\bCREATE\s+ROLE\s+(?P<name>{IDENT})",
            re.IGNORECASE,
        ),
    }
    seen: set[tuple[str, str, str]] = set()
    for entry in entries:
        tag = str(entry["tag"])
        path = root / "packages/db/drizzle" / f"{tag}.sql"
        sql = strip_sql_comments(path.read_text(encoding="utf-8"))
        for kind, pattern in patterns.items():
            for match in pattern.finditer(sql):
                groups = match.groupdict()
                if kind in {"tables", "views", "functions"}:
                    name = normalize_ref(groups["ref"])
                    record = {"name": name, "migration": tag}
                elif kind == "triggers":
                    name = unquote_identifier(groups["name"])
                    record = {
                        "name": name,
                        "table": normalize_ref(groups["table"]),
                        "migration": tag,
                    }
                elif kind == "policies":
                    name = unquote_identifier(groups["name"])
                    record = {
                        "name": name,
                        "table": normalize_ref(groups["table"]),
                        "migration": tag,
                    }
                elif kind == "rls":
                    name = normalize_ref(groups["table"])
                    record = {
                        "name": name,
                        "mode": groups["mode"].lower(),
                        "migration": tag,
                    }
                else:
                    name = unquote_identifier(groups["name"])
                    record = {"name": name, "migration": tag}
                signature = (kind, name, record.get("table", ""))
                if signature not in seen:
                    seen.add(signature)
                    inventory[kind].append(record)
    for records in inventory.values():
        records.sort(key=lambda row: tuple(row.values()))
    return inventory


def classify_domain(table_name: str) -> str:
    if table_name in WORKSPACE_ACCESS_TABLES:
        return "WorkspaceAccess"
    if table_name in ACCOUNTING_TABLES:
        return "Accounting"
    if table_name in IMPORTS_EVIDENCE_TABLES:
        return "ImportsEvidence"
    if table_name in INVESTMENTS_TABLES:
        return "Investments"
    if table_name in AUTOMATION_TABLES:
        return "Automation"
    if table_name in TAX_TABLES:
        return "Tax"
    return "LegacyRuntime"


def composite_key_rows(table: dict[str, Any], key: str) -> list[list[str]]:
    rows: list[list[str]] = []
    value = table.get(key, {})
    items = value.values() if isinstance(value, dict) else value
    for item in items:
        columns = item.get("columns", [])
        if columns:
            rows.append([str(column) for column in columns])
    return rows


def table_column_names(table: dict[str, Any]) -> set[str]:
    columns = table.get("columns", {})
    if isinstance(columns, dict):
        return {str(name) for name in columns}
    return {
        str(column.get("name"))
        for column in columns
        if isinstance(column, dict) and column.get("name") is not None
    }


def unique_index_rows(table: dict[str, Any]) -> list[list[str]]:
    """Return only unconditional, plain-column unique index keys.

    Expression and partial indexes cannot serve as a general FK source
    uniqueness proof. Drizzle stores index columns as `{expression, ...}`
    records, while generated normalized tables retain these rows under
    `uniqueIndexes`.
    """

    indexes = table.get("indexes", {})
    if isinstance(indexes, list):
        indexes = {str(index): value for index, value in enumerate(indexes)}
    if not isinstance(indexes, dict):
        indexes = {}
    available = table_column_names(table)
    rows: list[list[str]] = []
    for index in indexes.values():
        if not isinstance(index, dict) or not index.get("isUnique"):
            continue
        if index.get("where"):
            continue
        columns = index.get("columns", [])
        if not columns:
            continue
        names: list[str] = []
        valid = True
        for column in columns:
            if isinstance(column, str):
                name = column
            elif isinstance(column, dict):
                if column.get("isExpression"):
                    valid = False
                    break
                name = column.get("expression") or column.get("name")
            else:
                valid = False
                break
            # A small normalized fixture may omit its column dictionary; in
            # that case the index still proves source uniqueness. Full
            # Drizzle snapshots always provide `available`, so unknown index
            # expressions are rejected during normal generation.
            if name is None or (available and str(name) not in available):
                valid = False
                break
            names.append(str(name))
        if valid and names:
            rows.append(names)
    # Normalized model tables carry parsed index rows without the raw index
    # metadata. Keep this separate so validation can use the same exact key
    # inventory as source-cardinality derivation.
    for row in table.get("uniqueIndexes", []) or []:
        if row:
            rows.append([str(column) for column in row])
    return rows


def unique_key_candidates(table: dict[str, Any]) -> list[tuple[str, ...]]:
    primary = [
        str(name)
        for name, column in (table.get("columns", {}) or {}).items()
        if isinstance(column, dict) and column.get("primaryKey")
    ]
    rows = [primary] if primary else []
    rows.extend(composite_key_rows(table, "compositePrimaryKeys"))
    rows.extend(composite_key_rows(table, "uniqueConstraints"))
    rows.extend(unique_index_rows(table))
    candidates: list[tuple[str, ...]] = []
    for row in rows:
        candidate = tuple(str(column) for column in row)
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    return candidates


def is_unique_columns(table: dict[str, Any], columns: list[str]) -> bool:
    """Whether the source FK columns are guaranteed unique.

    A unique key contained in the FK columns is sufficient: if `run_id` is
    unique, `(run_id, sequence)` is also unique. This is intentionally a set
    subset comparison, since column order does not change uniqueness.
    """

    candidate = {str(column) for column in columns}
    return bool(candidate) and any(
        set(key).issubset(candidate) for key in unique_key_candidates(table)
    )


def has_exact_unique_key(table: dict[str, Any], columns: list[str]) -> bool:
    """Whether FK target columns match a declared key exactly.

    PostgreSQL FK targets must name a complete primary/unique key. Keep this
    check distinct from source uniqueness, where a strict subset is valid.
    """

    candidate = tuple(str(column) for column in columns)
    return bool(candidate) and any(
        candidate == key for key in unique_key_candidates(table)
    )


def run_generator_self_checks() -> None:
    """Protect the cardinality distinction with small schema fixtures."""

    base = {
        "columns": {
            "id": {"primaryKey": True},
            "run_id": {"primaryKey": False},
            "sequence": {"primaryKey": False},
            "other": {"primaryKey": False},
        },
        "compositePrimaryKeys": {},
        "uniqueConstraints": {
            "run": {"columns": ["run_id"]},
            "run_sequence": {"columns": ["run_id", "sequence"]},
        },
        "indexes": {},
    }
    assert is_unique_columns(base, ["run_id", "sequence"])
    assert is_unique_columns(base, ["sequence", "run_id"])
    assert not is_unique_columns(base, ["sequence", "other"])
    assert has_exact_unique_key(base, ["run_id"])
    assert has_exact_unique_key(base, ["run_id", "sequence"])
    assert not has_exact_unique_key(base, ["run_id", "sequence", "other"])

    indexed = {
        "columns": base["columns"],
        "compositePrimaryKeys": {},
        "uniqueConstraints": {},
        "indexes": {
            "plain": {
                "isUnique": True,
                "columns": [{"expression": "sequence", "isExpression": False}],
            },
            "partial": {
                "isUnique": True,
                "where": "sequence IS NOT NULL",
                "columns": [{"expression": "other", "isExpression": False}],
            },
            "expression": {
                "isUnique": True,
                "columns": [{"expression": "lower(other)", "isExpression": True}],
            },
        },
    }
    assert is_unique_columns(indexed, ["sequence", "other"])
    assert not is_unique_columns(indexed, ["other"])
    assert has_exact_unique_key(indexed, ["sequence"])


def build_model(snapshot: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    raw_tables = snapshot.get("tables", {})
    tables: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}
    for key, raw in sorted(raw_tables.items()):
        schema = str(raw.get("schema") or key.split(".", 1)[0])
        name = str(raw.get("name") or key.split(".", 1)[-1])
        explicit_primary_key = [
            str(column_name)
            for column_name, column in raw.get("columns", {}).items()
            if column.get("primaryKey")
        ]
        composite_primary_keys = composite_key_rows(raw, "compositePrimaryKeys")
        primary_key = explicit_primary_key or (
            composite_primary_keys[0] if composite_primary_keys else []
        )
        table = {
            "key": f"{schema}.{name}",
            "schema": schema,
            "name": name,
            "domain": classify_domain(name),
            "columns": [],
            "primaryKey": primary_key,
            "compositePrimaryKeys": composite_primary_keys,
            "uniqueConstraints": composite_key_rows(raw, "uniqueConstraints"),
            "uniqueIndexes": unique_index_rows(raw),
            "indexes": len(raw.get("indexes", {})),
            "checks": len(raw.get("checkConstraints", {})),
            "snapshotRls": bool(raw.get("isRLSEnabled", False)),
        }
        for column_name, column in raw.get("columns", {}).items():
            table["columns"].append(
                {
                    "name": str(column.get("name") or column_name),
                    "type": str(column.get("type") or "unknown"),
                    "notNull": bool(column.get("notNull")),
                    "primaryKey": str(column_name) in set(primary_key),
                    "default": column.get("default"),
                }
            )
        tables.append(table)
        by_key[table["key"]] = table

    fks: list[dict[str, Any]] = []
    for key, raw in sorted(raw_tables.items()):
        source_key = normalize_ref(key)
        source_table = by_key[source_key]
        for fk_name, fk in sorted(raw.get("foreignKeys", {}).items()):
            target_schema = str(fk.get("schemaTo") or source_table["schema"])
            target_key = f"{target_schema}.{fk['tableTo']}"
            source_columns = [str(column) for column in fk.get("columnsFrom", [])]
            target_columns = [str(column) for column in fk.get("columnsTo", [])]
            nullable = any(
                not next(
                    column["notNull"]
                    for column in source_table["columns"]
                    if column["name"] == source_column
                )
                for source_column in source_columns
                if any(column["name"] == source_column for column in source_table["columns"])
            )
            edge = {
                "name": str(fk.get("name") or fk_name),
                "source": source_key,
                "target": target_key,
                "sourceColumns": source_columns,
                "targetColumns": target_columns,
                "onDelete": str(fk.get("onDelete") or "no action"),
                "onUpdate": str(fk.get("onUpdate") or "no action"),
                "nullable": nullable,
                "sourceUnique": is_unique_columns(raw, source_columns),
            }
            fks.append(edge)
    fk_columns: dict[str, set[str]] = {table["key"]: set() for table in tables}
    for fk in fks:
        fk_columns.setdefault(fk["source"], set()).update(fk["sourceColumns"])
    for table in tables:
        for column in table["columns"]:
            column["foreignKey"] = column["name"] in fk_columns.get(table["key"], set())

    counts = {
        "tables": len(tables),
        "foreignKeys": len(fks),
        "compositePrimaryKeys": sum(len(table["compositePrimaryKeys"]) for table in tables),
        "uniqueConstraints": sum(len(table["uniqueConstraints"]) for table in tables),
        "indexes": sum(table["indexes"] for table in tables),
        "checks": sum(table["checks"] for table in tables),
    }
    return tables, fks, counts


def validate_model(
    tables: list[dict[str, Any]],
    fks: list[dict[str, Any]],
    expected_tables: int | None,
    expected_fks: int | None,
) -> dict[str, Any]:
    table_map = {table["key"]: table for table in tables}
    errors: list[str] = []
    warnings: list[str] = []
    if expected_tables is not None and len(tables) != expected_tables:
        errors.append(f"expected {expected_tables} tables, found {len(tables)}")
    if expected_fks is not None and len(fks) != expected_fks:
        errors.append(f"expected {expected_fks} foreign keys, found {len(fks)}")
    for fk in fks:
        source = table_map.get(fk["source"])
        target = table_map.get(fk["target"])
        if source is None:
            errors.append(f"{fk['name']}: source table {fk['source']} is absent")
            continue
        if target is None:
            errors.append(f"{fk['name']}: target table {fk['target']} is absent")
            continue
        source_columns = {column["name"] for column in source["columns"]}
        target_columns = {column["name"] for column in target["columns"]}
        for column in fk["sourceColumns"]:
            if column not in source_columns:
                errors.append(f"{fk['name']}: source column {fk['source']}.{column} is absent")
        for column in fk["targetColumns"]:
            if column not in target_columns:
                errors.append(f"{fk['name']}: target column {fk['target']}.{column} is absent")
        if len(fk["sourceColumns"]) != len(fk["targetColumns"]):
            errors.append(f"{fk['name']}: composite endpoint column counts differ")
        if not has_exact_unique_key(
            {
                "columns": {column["name"]: column for column in target["columns"]},
                "compositePrimaryKeys": {
                    f"pk-{index}": {"columns": row}
                    for index, row in enumerate(target["compositePrimaryKeys"])
                },
                "uniqueConstraints": {
                    f"uq-{index}": {"columns": row}
                    for index, row in enumerate(target["uniqueConstraints"])
                },
                "uniqueIndexes": target["uniqueIndexes"],
            },
            fk["targetColumns"],
        ):
            warnings.append(
                f"{fk['name']}: target columns {fk['target']}({','.join(fk['targetColumns'])}) "
                "are not marked unique in the snapshot"
            )
    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "checkedForeignKeys": len(fks),
        "checkedTables": len(tables),
        "endpointColumnsChecked": sum(len(fk["sourceColumns"]) + len(fk["targetColumns"]) for fk in fks),
    }


def safe_ref(key: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_]", "_", key.upper())
    if value and value[0].isdigit():
        value = f"T_{value}"
    return value


def mermaid_type(value: str) -> str:
    value = value.strip().lower()
    value = value.replace("timestamp with time zone", "timestamptz")
    value = value.replace("timestamp without time zone", "timestamp")
    value = value.replace("double precision", "double_precision")
    value = re.sub(r"[^A-Za-z0-9_]", "_", value)
    return value.strip("_") or "unknown"


def relation_cardinality(fk: dict[str, Any]) -> tuple[str, str, str]:
    target_side = "o|" if fk["nullable"] else "||"
    source_side = "o|" if fk["sourceUnique"] else "o{"
    nullability = "nullable" if fk["nullable"] else "required"
    multiplicity = "1:1" if fk["sourceUnique"] else "1:N"
    return target_side, source_side, f"{nullability}; {multiplicity}"


def mermaid_table_block(table: dict[str, Any], columns: list[dict[str, Any]] | None = None) -> list[str]:
    rows = columns if columns is not None else table["columns"]
    lines = [f"  {safe_ref(table['key'])} {{"]
    for column in rows:
        flags: list[str] = []
        if column.get("primaryKey"):
            flags.append("PK")
        if column.get("foreignKey"):
            flags.append("FK")
        suffix = f" {' '.join(flags)}" if flags else ""
        lines.append(f"    {mermaid_type(column['type'])} {column['name']}{suffix}")
    lines.append("  }")
    return lines


def mermaid_edges(fks: list[dict[str, Any]], allowed: set[str] | None = None) -> list[str]:
    lines: list[str] = []
    for fk in fks:
        if allowed is not None and fk["source"] not in allowed and fk["target"] not in allowed:
            continue
        left, right, cardinality = relation_cardinality(fk)
        source_columns = ", ".join(fk["sourceColumns"])
        target_columns = ", ".join(fk["targetColumns"])
        label = (
            f"{source_columns} -> {target_columns}; {cardinality}; "
            f"delete {fk['onDelete']}; update {fk['onUpdate']}"
        )
        label = label.replace('"', "'")
        lines.append(
            f"  {safe_ref(fk['target'])} {left}--{right} {safe_ref(fk['source'])} : \"{label}\""
        )
    return lines


def full_mermaid(tables: list[dict[str, Any]], fks: list[dict[str, Any]], revision: str, counts: dict[str, int]) -> str:
    lines = [
        "%% EMDO current implementation database ERD",
        f"%% Drizzle journal revision {revision}; {counts['tables']} tables; {counts['foreignKeys']} foreign keys",
        "%% Mermaid-safe type tokens are normalized; exact PostgreSQL types are in schema-index.json and database-erd.html.",
        "erDiagram",
    ]
    for table in tables:
        lines.extend(mermaid_table_block(table))
    lines.extend(mermaid_edges(fks))
    return "\n".join(lines) + "\n"


def domain_mermaid(
    domain: str,
    tables: list[dict[str, Any]],
    fks: list[dict[str, Any]],
    revision: str,
) -> str:
    selected = {table["key"] for table in tables if table["domain"] == domain}
    endpoints = set(selected)
    for fk in fks:
        if fk["source"] in selected or fk["target"] in selected:
            endpoints.add(fk["source"])
            endpoints.add(fk["target"])
    table_map = {table["key"]: table for table in tables}
    lines = [
        f"%% EMDO {domain} domain view; implementation revision {revision}",
        "%% External context nodes contain only FK endpoint columns; consult the full ERD for every column.",
        "erDiagram",
    ]
    for key in sorted(endpoints):
        table = table_map[key]
        if key in selected:
            lines.extend(mermaid_table_block(table))
        else:
            endpoint_columns: set[str] = set()
            for fk in fks:
                if fk["source"] == key:
                    endpoint_columns.update(fk["sourceColumns"])
                if fk["target"] == key:
                    endpoint_columns.update(fk["targetColumns"])
            columns = [column for column in table["columns"] if column["name"] in endpoint_columns]
            lines.append(f"  %% external context stub: {key}")
            lines.extend(mermaid_table_block(table, columns))
    lines.extend(mermaid_edges(fks, selected))
    return "\n".join(lines) + "\n"


def svg_text(x: float, y: float, value: str, size: int, fill: str, weight: str = "400") -> str:
    return (
        f'<text x="{x:g}" y="{y:g}" font-family="ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" '
        f'font-size="{size}px" fill="{fill}" font-weight="{weight}">{html.escape(value)}</text>'
    )


def domain_svg(domain: str, tables: list[dict[str, Any]], fks: list[dict[str, Any]], revision: str) -> str:
    table_map = {table["key"]: table for table in tables}
    selected = {table["key"] for table in tables if table["domain"] == domain}
    endpoint_keys = set(selected)
    for fk in fks:
        if fk["source"] in selected or fk["target"] in selected:
            endpoint_keys.update((fk["source"], fk["target"]))
    external = endpoint_keys - selected
    node_w = 360
    node_gap_x = 34
    row_gap = 235
    internal_cols = 3 if len(selected) > 8 else 2
    external_cols = 1 if external else 0
    total_cols = internal_cols + external_cols
    width = 90 + total_cols * node_w + (total_cols - 1) * node_gap_x
    ordered_selected = sorted(selected)
    ordered_external = sorted(external)
    positions: dict[str, tuple[float, float, float]] = {}
    node_h: dict[str, float] = {}
    for index, key in enumerate(ordered_selected):
        col = index % internal_cols
        row = index // internal_cols
        x = 45 + col * (node_w + node_gap_x)
        y = 110 + row * row_gap
        table = table_map[key]
        visible = table["columns"][:14]
        height = 66 + len(visible) * 18 + (20 if len(table["columns"]) > len(visible) else 0)
        positions[key] = (x, y, height)
        node_h[key] = height
    for index, key in enumerate(ordered_external):
        col = internal_cols + (index % max(external_cols, 1))
        row = index // max(external_cols, 1)
        x = 45 + col * (node_w + node_gap_x)
        y = 110 + row * row_gap
        table = table_map[key]
        height = 104
        positions[key] = (x, y, height)
        node_h[key] = height
    rows = max(
        (len(ordered_selected) + internal_cols - 1) // internal_cols,
        (len(ordered_external) + max(external_cols, 1) - 1) // max(external_cols, 1),
        1,
    )
    height = 145 + rows * row_gap
    color = DOMAIN_COLORS[domain]
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        "<defs><marker id=\"arrow\" markerWidth=\"8\" markerHeight=\"8\" refX=\"7\" refY=\"4\" orient=\"auto\"><path d=\"M0,0 L8,4 L0,8 z\" fill=\"#94a3b8\"/></marker></defs>",
        '<rect width="100%" height="100%" fill="#07111f"/>',
        svg_text(45, 48, f"EMDO · {domain}", 28, "#f8fafc", "700"),
        svg_text(45, 76, f"Implementation revision {revision} · {len(selected)} domain tables · dashed edges cross domain boundaries", 14, "#94a3b8"),
    ]
    for fk in fks:
        if fk["source"] not in endpoint_keys or fk["target"] not in endpoint_keys:
            continue
        source = positions[fk["source"]]
        target = positions[fk["target"]]
        sx, sy, sh = source
        tx, ty, th = target
        x1 = tx + node_w if tx <= sx else tx
        y1 = ty + th / 2
        x2 = sx if tx <= sx else sx + node_w
        y2 = sy + sh / 2
        mid = (x1 + x2) / 2
        dash = ' stroke-dasharray="8 7"' if fk["source"] not in selected or fk["target"] not in selected else ""
        lines.append(
            f'<path d="M{x1:g},{y1:g} C{mid:g},{y1:g} {mid:g},{y2:g} {x2:g},{y2:g}" fill="none" stroke="#64748b" stroke-width="1.4"{dash} marker-end="url(#arrow)"/>'
        )
    for key, (x, y, h) in positions.items():
        table = table_map[key]
        is_external = key not in selected
        border = "#475569" if is_external else color
        fill = "#111c2d" if is_external else "#0f2136"
        lines.append(f'<g><rect x="{x:g}" y="{y:g}" width="{node_w}" height="{h:g}" rx="12" fill="{fill}" stroke="{border}" stroke-width="{2 if not is_external else 1}"/>')
        title = f"{table['schema']}.{table['name']}"
        lines.append(svg_text(x + 16, y + 26, title, 15, "#f8fafc", "700"))
        subtitle = "external context" if is_external else f"{table['domain']} · {len(table['columns'])} columns"
        lines.append(svg_text(x + 16, y + 46, subtitle, 11, "#94a3b8"))
        columns = table["columns"] if not is_external else [column for column in table["columns"] if any(column["name"] in fk["targetColumns"] for fk in fks if fk["target"] == key)]
        for index, column in enumerate(columns[:14]):
            marker = "PK" if column["primaryKey"] else ("FK" if column.get("foreignKey") else ("?" if not column["notNull"] else ""))
            suffix = f"  {marker}" if marker else ""
            lines.append(svg_text(x + 16, y + 68 + index * 18, f"{column['name']}{suffix}", 11, "#cbd5e1"))
        if not is_external and len(columns) > 14:
            lines.append(svg_text(x + 16, y + 68 + 14 * 18, f"+ {len(columns) - 14} more columns", 11, "#94a3b8"))
        lines.append("</g>")
    lines.append("</svg>")
    return "\n".join(lines) + "\n"


def html_document(
    payload: dict[str, Any],
    full_mermaid_source: str,
) -> str:
    payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")
    mermaid_json = json.dumps(full_mermaid_source, ensure_ascii=False).replace("</", "<\\/")
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EMDO database ERD · implementation {html.escape(payload["revision"])}</title>
<style>
:root {{ color-scheme: dark; --bg:#07111f; --panel:#0d1a2c; --panel-2:#111f33; --ink:#e5edf7; --muted:#8fa4bd; --line:#29415e; --accent:#62d8c3; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; width:100%; height:100vh; min-height:100vh; display:flex; flex-direction:column; background:radial-gradient(circle at 20% 0%,#122b43 0,#07111f 42%,#050b14 100%); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; overflow:hidden; }}
header {{ min-height:82px; padding:18px 24px 14px; display:flex; gap:20px; align-items:flex-start; border-bottom:1px solid rgba(148,163,184,.18); background:rgba(7,17,31,.86); backdrop-filter:blur(15px); position:relative; z-index:5; }}
h1 {{ margin:0; font-size:22px; letter-spacing:-.02em; }}
.eyebrow {{ margin:0 0 3px; text-transform:uppercase; letter-spacing:.12em; font-size:10px; color:var(--accent); font-weight:700; }}
.sub {{ margin:4px 0 0; color:var(--muted); font-size:12px; }}
.badge {{ display:inline-flex; align-items:center; padding:5px 9px; border:1px solid rgba(98,216,195,.35); border-radius:999px; color:#b3f6e9; background:rgba(20,184,166,.08); font-size:11px; white-space:nowrap; }}
.toolbar {{ margin-left:auto; display:flex; flex-wrap:wrap; justify-content:flex-end; gap:7px; align-items:center; }}
input,select,button {{ border:1px solid var(--line); border-radius:8px; background:var(--panel-2); color:var(--ink); font:inherit; }}
input,select {{ height:34px; padding:0 10px; min-width:180px; outline:none; }}
input:focus,select:focus {{ border-color:var(--accent); box-shadow:0 0 0 3px rgba(98,216,195,.13); }}
button {{ height:34px; padding:0 10px; cursor:pointer; transition:background .15s,border-color .15s,transform .15s; }}
button:hover {{ background:#17304b; border-color:#4c6c8e; transform:translateY(-1px); }}
.layout {{ flex:1 1 auto; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 350px; }}
#canvas {{ position:relative; min-width:0; overflow:hidden; background-image:linear-gradient(rgba(148,163,184,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.06) 1px,transparent 1px); background-size:28px 28px; }}
#erd {{ width:100%; height:100%; touch-action:none; user-select:none; cursor:grab; }}
#erd.dragging {{ cursor:grabbing; }}
.edge {{ fill:none; stroke:#526b86; stroke-width:1.4; opacity:.48; transition:opacity .15s,stroke .15s,stroke-width .15s; }}
.edge.active {{ opacity:1; stroke:var(--accent); stroke-width:2.6; }}
.edge.dim {{ opacity:.08; }}
.node {{ cursor:pointer; transition:opacity .15s; outline:none; }}
.node:focus-visible rect {{ stroke:var(--accent); stroke-width:3; filter:drop-shadow(0 0 9px rgba(98,216,195,.32)); }}
.node.dim {{ opacity:.1; }}
.node.match rect {{ stroke:#fff; stroke-width:2.5; }}
.node.selected rect {{ stroke:var(--accent); stroke-width:3; filter:drop-shadow(0 0 9px rgba(98,216,195,.32)); }}
.node-title {{ fill:#f8fafc; font-weight:700; font-size:14px; }}
.node-meta,.node-more {{ fill:#8fa4bd; font-size:10px; }}
.node-col {{ fill:#cbd5e1; font-size:10px; }}
.domain-title {{ fill:#d9e7f5; font-size:17px; font-weight:700; }}
.domain-count {{ fill:#7690ab; font-size:10px; }}
aside {{ overflow:auto; background:rgba(13,26,44,.9); border-left:1px solid rgba(148,163,184,.18); padding:20px 18px 30px; }}
aside h2 {{ margin:0 0 4px; font-size:18px; letter-spacing:-.015em; overflow-wrap:anywhere; }}
aside h3 {{ margin:20px 0 7px; color:#b6c9dd; font-size:11px; text-transform:uppercase; letter-spacing:.1em; }}
.detail-muted {{ color:var(--muted); font-size:12px; }}
.stat-grid {{ display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:14px 0; }}
.stat {{ padding:9px 10px; background:#111f33; border:1px solid rgba(148,163,184,.14); border-radius:8px; }}
.stat b {{ display:block; font-size:16px; }} .stat span {{ color:var(--muted); font-size:10px; }}
.columns {{ display:grid; gap:5px; }}
.column {{ padding:7px 8px; border-radius:7px; background:#111f33; border:1px solid rgba(148,163,184,.1); }}
.column-name {{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; }}
.column-type {{ color:#9fb6ce; font-size:10px; margin-top:2px; }}
.pill {{ display:inline-block; margin-left:4px; padding:1px 4px; border-radius:4px; font-size:9px; color:#b7f5e8; background:rgba(20,184,166,.13); }}
.relation {{ padding:7px 8px; margin-bottom:5px; border-left:2px solid #52718f; background:#111f33; border-radius:0 7px 7px 0; font-size:11px; }}
.relation small {{ display:block; color:#8fa4bd; margin-top:2px; }}
.legend {{ position:absolute; bottom:15px; left:15px; max-width:calc(100% - 30px); padding:9px 11px; background:rgba(7,17,31,.86); border:1px solid rgba(148,163,184,.2); border-radius:9px; color:#9fb6ce; font-size:10px; pointer-events:none; }}
.legend span {{ display:inline-flex; align-items:center; margin-right:10px; }} .dot {{ width:8px; height:8px; border-radius:50%; margin-right:4px; }}
@media (max-width:900px) {{ body {{ height:auto; overflow:auto; }} header {{ flex-wrap:wrap; }} .toolbar {{ margin-left:0; justify-content:flex-start; }} .layout {{ flex:0 0 auto; min-height:calc(100vh - 160px); grid-template-columns:1fr; }} #canvas {{ height:65vh; min-height:440px; }} aside {{ border-left:0; border-top:1px solid rgba(148,163,184,.18); }} }}
</style>
</head>
<body>
<header>
  <div><p class="eyebrow">EMDO · current implementation database</p><h1>Schema ERD</h1><p class="sub">Journal revision {html.escape(payload["revision"])} · actual Drizzle snapshot tables and foreign keys</p></div>
  <span class="badge">{payload["counts"]["tables"]} tables · {payload["counts"]["foreignKeys"]} FKs</span>
  <div class="toolbar"><input id="search" type="search" placeholder="Search tables or columns…" aria-label="Search tables or columns"><select id="domain" aria-label="Filter domain"><option value="all">All domains</option>{''.join(f'<option value="{html.escape(domain)}">{html.escape(domain)}</option>' for domain in DOMAIN_ORDER)}</select><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="fit">Fit selection</button><button id="reset">Reset</button><button id="download-mmd">Download Mermaid</button><button id="download-json">Download schema JSON</button></div>
</header>
<div class="layout"><main id="canvas"><svg id="erd" role="img" aria-label="Interactive EMDO database entity relationship diagram"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#526b86"></path></marker><pattern id="minor-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#29415e" stroke-opacity=".22" stroke-width="1"></path></pattern></defs><rect width="100%" height="100%" fill="url(#minor-grid)"></rect><g id="viewport"></g></svg><div class="legend" id="legend"></div></main><aside id="detail"><p class="eyebrow">Selection</p><h2>Choose a table</h2><p class="detail-muted">Search, filter, or click a node. The full column list, keys, and FK endpoints appear here.</p><div class="stat-grid"><div class="stat"><b>{payload["counts"]["tables"]}</b><span>snapshot tables</span></div><div class="stat"><b>{payload["counts"]["foreignKeys"]}</b><span>foreign keys</span></div><div class="stat"><b>{payload["customSql"]["counts"]["views"]}</b><span>SQL views inventoried</span></div><div class="stat"><b>{payload["customSql"]["counts"]["triggers"]}</b><span>SQL triggers inventoried</span></div></div><h3>Scope note</h3><p class="detail-muted">The graph contains only Drizzle snapshot tables and FK metadata. SQL-only views, RLS, policies, and triggers are listed as implementation behavior and do not create inferred relations.</p></aside></div>
<script>
const DATA={payload_json};
const FULL_MERMAID={mermaid_json};
const svg=document.getElementById('erd'),viewport=document.getElementById('viewport'),detail=document.getElementById('detail'),search=document.getElementById('search'),domainSelect=document.getElementById('domain'),overviewHtml=detail.innerHTML;
let selected=null, transform={{x:30,y:30,s:.72}}, dragging=false, dragStart=null;
const esc=(v)=>String(v??'').replace(/[&<>"']/g,(c)=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c]));
const byKey=Object.fromEntries(DATA.tables.map(t=>[t.key,t]));
const nodeHeight=(t)=>t.layout.height;
function pathFor(f){{const a=byKey[f.target],b=byKey[f.source];if(!a||!b)return '';const x1=a.layout.x+DATA.layout.nodeWidth,y1=a.layout.y+nodeHeight(a)/2,x2=b.layout.x,y2=b.layout.y+nodeHeight(b)/2,m=(x1+x2)/2;return `M ${{x1}} ${{y1}} C ${{m}} ${{y1}}, ${{m}} ${{y2}}, ${{x2}} ${{y2}}`;}}
function matchesTable(t,q,domain){{return (!q||JSON.stringify(t).toLowerCase().includes(q))&&(domain==='all'||t.domain===domain);}}
function currentMatches(){{const q=search.value.trim().toLowerCase(),domain=domainSelect.value;return DATA.tables.filter((t)=>matchesTable(t,q,domain));}}
function render(){{viewport.setAttribute('transform',`translate(${{transform.x}} ${{transform.y}}) scale(${{transform.s}})`);}}
function draw(){{viewport.innerHTML='';const labels=document.createElementNS('http://www.w3.org/2000/svg','g');DATA.domains.forEach((d)=>{{const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('x',DATA.layout.domainX[d]);text.setAttribute('y','42');text.setAttribute('class','domain-title');text.textContent=d;labels.appendChild(text);const count=document.createElementNS('http://www.w3.org/2000/svg','text');count.setAttribute('x',DATA.layout.domainX[d]);count.setAttribute('y','60');count.setAttribute('class','domain-count');count.textContent=`${{DATA.domainTables[d].length}} tables`;labels.appendChild(count);}});viewport.appendChild(labels);const edges=document.createElementNS('http://www.w3.org/2000/svg','g');DATA.fks.forEach((f,i)=>{{const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',pathFor(f));p.setAttribute('class','edge');p.setAttribute('marker-end','url(#arrow)');p.dataset.index=i;edges.appendChild(p);}});viewport.appendChild(edges);const nodes=document.createElementNS('http://www.w3.org/2000/svg','g');DATA.tables.forEach((t)=>{{const g=document.createElementNS('http://www.w3.org/2000/svg','g');g.setAttribute('class','node');g.dataset.key=t.key;g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label','Open '+t.key+' table details');g.setAttribute('transform',`translate(${{t.layout.x}} ${{t.layout.y}})`);g.addEventListener('click',(event)=>{{event.stopPropagation();select(t.key);}});g.addEventListener('keydown',(event)=>{{if(event.key==='Enter'||event.key===' '){{event.preventDefault();event.stopPropagation();select(t.key);}}}});const r=document.createElementNS('http://www.w3.org/2000/svg','rect');r.setAttribute('width',DATA.layout.nodeWidth);r.setAttribute('height',t.layout.height);r.setAttribute('rx','12');r.setAttribute('fill','#0f2136');r.setAttribute('stroke',DATA.colors[t.domain]);r.setAttribute('stroke-width','1.7');g.appendChild(r);const title=document.createElementNS('http://www.w3.org/2000/svg','text');title.setAttribute('x','14');title.setAttribute('y','23');title.setAttribute('class','node-title');title.textContent=t.key;g.appendChild(title);const meta=document.createElementNS('http://www.w3.org/2000/svg','text');meta.setAttribute('x','14');meta.setAttribute('y','40');meta.setAttribute('class','node-meta');meta.textContent=`${{t.domain}} · ${{t.columns.length}} columns · PK ${{t.primaryKey.length?t.primaryKey.join(', '):'none'}}`;g.appendChild(meta);t.columns.slice(0,DATA.layout.visibleColumns).forEach((c,j)=>{{const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('x','14');text.setAttribute('y',String(59+j*16));text.setAttribute('class','node-col');text.textContent=`${{c.primaryKey?'◆ ':c.foreignKey?'↳ ':''}}${{c.name}}${{c.notNull?'':' ?'}}`;g.appendChild(text);}});if(t.columns.length>DATA.layout.visibleColumns){{const more=document.createElementNS('http://www.w3.org/2000/svg','text');more.setAttribute('x','14');more.setAttribute('y',String(59+DATA.layout.visibleColumns*16));more.setAttribute('class','node-more');more.textContent=`+ ${{t.columns.length-DATA.layout.visibleColumns}} more · click for details`;g.appendChild(more);}}nodes.appendChild(g);}});viewport.appendChild(nodes);render();updateFilter();}}
function select(key){{selected=key;const t=byKey[key];if(!t)return;const outgoing=DATA.fks.filter(f=>f.source===key),incoming=DATA.fks.filter(f=>f.target===key);detail.innerHTML=`<p class="eyebrow">${{esc(t.domain)}}</p><h2>${{esc(t.key)}}</h2><p class="detail-muted">Actual snapshot table · ${{t.columns.length}} columns · ${{t.indexes}} indexes · ${{t.checks}} checks</p><div class="stat-grid"><div class="stat"><b>${{t.primaryKey.length}}</b><span>PK columns</span></div><div class="stat"><b>${{t.compositePrimaryKeys.length}}</b><span>composite PKs</span></div><div class="stat"><b>${{outgoing.length}}</b><span>outgoing FKs</span></div><div class="stat"><b>${{incoming.length}}</b><span>incoming FKs</span></div></div><h3>Columns</h3><div class="columns">${{t.columns.map(c=>`<div class="column"><div class="column-name">${{esc(c.name)}}${{c.primaryKey?'<span class="pill">PK</span>':''}}${{c.foreignKey?'<span class="pill">FK</span>':''}}${{c.notNull?'<span class="pill">NOT NULL</span>':'<span class="pill">NULL</span>'}}</div><div class="column-type">${{esc(c.type)}}${{c.default!==null&&c.default!==undefined?` · default ${{esc(c.default)}}`:''}}</div></div>`).join('')}}</div><h3>Foreign keys</h3>${{outgoing.length?outgoing.map(f=>`<div class="relation">${{esc(f.name)}}<small>${{esc(f.sourceColumns.join(', '))}} → ${{esc(f.target)}} (${{esc(f.targetColumns.join(', '))}})</small><small>${{f.nullable?'nullable':'required'}} · ${{f.sourceUnique?'1:1':'1:N'}} · delete ${{esc(f.onDelete)}} · update ${{esc(f.onUpdate)}}</small></div>`).join(''):'<p class="detail-muted">No outgoing foreign keys.</p>'}}<h3>Referenced by</h3>${{incoming.length?incoming.map(f=>`<div class="relation">${{esc(f.source)}}<small>${{esc(f.sourceColumns.join(', '))}} → ${{esc(f.targetColumns.join(', '))}}</small></div>`).join(''):'<p class="detail-muted">No incoming foreign keys.</p>'}}`;detail.scrollTop=0;updateFilter();}}
let lastFilterKey='';
function updateFilter(refit=false){{const q=search.value.trim().toLowerCase(),domain=domainSelect.value,filterKey=q+'\\u0000'+domain;document.querySelectorAll('.node').forEach((n)=>{{const t=byKey[n.dataset.key],match=matchesTable(t,q,domain);n.classList.toggle('dim',!match);n.classList.toggle('match',Boolean(q&&match));n.classList.toggle('selected',n.dataset.key===selected);}});document.querySelectorAll('.edge').forEach((e)=>{{const f=DATA.fks[Number(e.dataset.index)],match=(!q||JSON.stringify(f).toLowerCase().includes(q)||JSON.stringify(byKey[f.source]).toLowerCase().includes(q)||JSON.stringify(byKey[f.target]).toLowerCase().includes(q))&&(domain==='all'||byKey[f.source].domain===domain||byKey[f.target].domain===domain);e.classList.toggle('dim',!match);e.classList.toggle('active',Boolean(selected&&(f.source===selected||f.target===selected)));}});if(refit&&filterKey!==lastFilterKey)fitVisible();lastFilterKey=filterKey;}}
function fitVisible(){{const rect=svg.getBoundingClientRect(),matches=currentMatches(),nodes=matches.length?matches:DATA.tables,pad=35;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;nodes.forEach((t)=>{{minX=Math.min(minX,t.layout.x);minY=Math.min(minY,t.layout.y);maxX=Math.max(maxX,t.layout.x+DATA.layout.nodeWidth);maxY=Math.max(maxY,t.layout.y+t.layout.height);}});const contentWidth=Math.max(DATA.layout.nodeWidth,maxX-minX),contentHeight=Math.max(120,maxY-minY),availableWidth=Math.max(1,rect.width-pad*2),availableHeight=Math.max(1,rect.height-pad*2),scale=Math.min(availableWidth/contentWidth,availableHeight/contentHeight,1);transform={{s:Math.max(.04,scale),x:pad-minX*scale,y:pad-minY*scale}};render();}}
function fit(){{fitVisible();}}
function reset(){{transform={{x:30,y:30,s:.72}};selected=null;search.value='';domainSelect.value='all';detail.innerHTML=overviewHtml;detail.scrollTop=0;draw();fit();}}
function zoomAround(factor,clientX,clientY){{const rect=svg.getBoundingClientRect(),px=clientX===undefined?rect.width/2:clientX-rect.left,py=clientY===undefined?rect.height/2:clientY-rect.top;transform.x=px-(px-transform.x)*factor;transform.y=py-(py-transform.y)*factor;transform.s=Math.max(.04,Math.min(2.4,transform.s*factor));render();}}
const activePointers=new Map();let pinchDistance=null;
const pointerDistance=()=>{{const points=[...activePointers.values()];return points.length<2?0:Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y);}};
const pointerCenter=()=>{{const points=[...activePointers.values()];return points.length<2?null:{{x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2}};}};
svg.addEventListener('pointerdown',(e)=>{{if(e.target?.closest?.('.node'))return;activePointers.set(e.pointerId,{{x:e.clientX,y:e.clientY}});if(activePointers.size===2){{dragging=false;pinchDistance=pointerDistance();return;}}dragging=true;dragStart={{x:e.clientX,y:e.clientY,tx:transform.x,ty:transform.y}};svg.classList.add('dragging');svg.setPointerCapture(e.pointerId);}});svg.addEventListener('pointermove',(e)=>{{if(activePointers.has(e.pointerId))activePointers.set(e.pointerId,{{x:e.clientX,y:e.clientY}});if(activePointers.size>=2){{const distance=pointerDistance(),center=pointerCenter();if(pinchDistance&&distance&&center)zoomAround(distance/pinchDistance,center.x,center.y);pinchDistance=distance;return;}}if(!dragging)return;transform.x=dragStart.tx+e.clientX-dragStart.x;transform.y=dragStart.ty+e.clientY-dragStart.y;render();}});svg.addEventListener('pointerup',(e)=>{{activePointers.delete(e.pointerId);if(activePointers.size<2)pinchDistance=null;dragging=false;svg.classList.remove('dragging');}});svg.addEventListener('pointercancel',(e)=>{{activePointers.delete(e.pointerId);if(activePointers.size<2)pinchDistance=null;dragging=false;svg.classList.remove('dragging');}});svg.addEventListener('wheel',(e)=>{{e.preventDefault();zoomAround(e.deltaY<0?1.12:.89,e.clientX,e.clientY);}},{{passive:false}});svg.addEventListener('click',()=>{{selected=null;updateFilter();}});search.addEventListener('input',()=>updateFilter(true));domainSelect.addEventListener('change',()=>updateFilter(true));document.getElementById('zoom-out').addEventListener('click',()=>zoomAround(.82));document.getElementById('zoom-in').addEventListener('click',()=>zoomAround(1.22));document.getElementById('fit').addEventListener('click',fit);document.getElementById('reset').addEventListener('click',reset);document.getElementById('download-mmd').addEventListener('click',()=>download('emdo-database-erd.mmd',FULL_MERMAID,'text/plain'));document.getElementById('download-json').addEventListener('click',()=>download('emdo-database-schema.json',JSON.stringify(DATA,null,2),'application/json'));function download(name,body,type){{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([body],{{type}}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}}
DATA.domains.forEach((d)=>document.getElementById('legend').insertAdjacentHTML('beforeend',`<span><i class="dot" style="background:${{DATA.colors[d]}}"></i>${{esc(d)}}</span>`));draw();fit();
</script>
</body>
</html>
'''


def planned_gaps(revision: str) -> str:
    return f"""# Schema representation limits — implementation revision {revision}

This file is intentionally separate from the ERD. The entries below describe
application/runtime behavior or explicitly deferred delivery boundaries that
are not physical tables or foreign-key edges in the actual Drizzle snapshot.
They are not a missing-code inventory, and they are deliberately absent from
the graph.

## Platform and orchestration schema limits

- `Workspace`, `WorkspaceMembership`, `WorkspaceContext`, tier entitlements,
  and server-owned section-agent registrations are implemented application
  contracts and runtime registry descriptors. The current snapshot has
  `workspaces`, compatibility household/space membership records, and
  `workspace_entitlements`, but no one-to-one relational table for each
  contract field. The graph preserves those actual tables and does not invent
  replacement entities.
- EMDO delegation, readiness, manager-only parentage, and cross-section
  disclosure rules are enforced by application/runtime contracts. They are
  not represented as a dedicated delegation-run foreign-key graph in this
  snapshot.

## Finance and report-standardization schema limits

- Provider-specific report layouts, Astra-assisted mapping proposals,
  deterministic normalization, review, approval, and reuse are implemented
  through application contracts, services, UI, and the persisted
  `finance_report_mapping_*` and evidence tables. The ERD can show those
  storage boundaries but cannot express the runtime validation and semantic
  drift rules as relational edges.
- The current securities implementation stores instruments, movements, lots,
  corporate-action records, revisions, prices, and observed positions. The
  SQL-only lot-position view is inventoried separately; this graph does not
  infer a base-table relationship or claim that a view is authoritative.

## Tax schema limits

- Versioned tax package registries, country calculations, questionnaires,
  coverage/readiness checks, and review pipelines are implemented in the tax
  contracts and services. This snapshot has no dedicated persisted tables for
  package rules, form definitions, jurisdiction subdivisions, or generated
  return schedules, so those runtime capabilities cannot be inferred from
  the ERD.
- The `finance_tax_*` records provide persisted privacy, source-book, fact,
  snapshot, receipt, and case boundaries. They do not by themselves prove
  return-level coverage for Canada, USA, Mexico, Germany, South Korea, Japan,
  or France; package enablement and independent validation remain release
  evidence outside this schema artifact.

## Explicitly deferred workflows

Payroll, electronic filing, live banking/trading execution, and group
consolidation remain outside this implementation revision.
"""


def readme(
    revision: str,
    counts: dict[str, int],
    validation: dict[str, Any],
    snapshot_path: str,
    snapshot_hash: str,
    journal_path: str,
    journal_hash: str,
    custom: dict[str, Any],
) -> str:
    domains = "\n".join(f"- `{domain}` — domain `.mmd` and `.svg` files under `domains/`" for domain in DOMAIN_ORDER)
    custom_counts = custom["counts"]
    return f"""# EMDO database ERD — implementation revision {revision}

This is the current implementation ERD generated from the Drizzle PostgreSQL
metadata snapshot, not a conceptual target model. It contains **{counts['tables']} tables** and
**{counts['foreignKeys']} foreign keys** from the journal through `{revision}`.

## Reproduce

From the repository root:

```bash
python3 infra/scripts/generate-database-erd.py
python3 -m unittest discover -s infra/scripts -p 'test_generate_database_erd.py'
```

The generator uses only the Python standard library. It reads the selected
Drizzle snapshot and every SQL file named by the deployment journal, validates
all FK endpoints and columns, and writes this directory atomically by file.
The no-argument command follows the latest journal entry; use `--snapshot`,
`--journal`, `--output`, `--expected-tables`, and `--expected-fks` to pin a
specific implementation revision and its expected counts.

## Source provenance

| Source | Path | SHA-256 |
| --- | --- | --- |
| Drizzle snapshot | `{snapshot_path}` | `{snapshot_hash}` |
| Drizzle journal | `{journal_path}` | `{journal_hash}` |

The complete per-migration source manifest is in `schema-index.json`. Hashes
are included so a regenerated artifact can be compared to its exact source
inputs. This artifact is a source-level schema view; applying migrations to a
database and production readback remain separate validation steps.

## Validation

- Tables: `{counts['tables']}` (expected current revision: {counts['tables']})
- Foreign keys: `{counts['foreignKeys']}` (expected current revision: {counts['foreignKeys']})
- Composite primary keys: `{counts['compositePrimaryKeys']}`
- Unique constraints: `{counts['uniqueConstraints']}`
- Indexes: `{counts['indexes']}`
- Check constraints: `{counts['checks']}`
- FK endpoints checked: `{validation['checkedForeignKeys']}`; endpoint columns checked: `{validation['endpointColumnsChecked']}`
- Result: **{'PASS' if validation['ok'] else 'FAIL'}**

The machine-readable result is `validation.json`. Any missing table or source/
target column causes generation to fail. Cardinality is derived from source
FK nullability and source uniqueness; every composite column mapping is shown
in the relation label and full detail panel.

## Artifacts

- `database-erd.html` — self-contained interactive SVG ERD. Search and filter
  by domain, pan/zoom, click a table for every exact column and FK, and
  download the full Mermaid or schema JSON without a network request.
- `database-erd.mmd` — full downloadable Mermaid ER diagram for all tables and
  foreign keys.
- `schema-index.json` — complete normalized table, column, key, FK, count, and
  source-provenance index used by the HTML and generator.
- `validation.json` — endpoint and count validation output.
- `custom-sql-inventory.json` — SQL-only tables, views, functions, triggers,
  policies, RLS operations, and roles discovered in journaled migration SQL.
- `planned-gaps.md` — schema representation limits and deferred boundaries.
  Entries may be implemented in application/runtime code while remaining
  deliberately absent from this physical table graph.

## Readable domain views

{domains}

Domain SVGs and Mermaid files include external context stubs only when a real
FK crosses a domain boundary. The stub is a readability aid; it does not add a
new relation or claim a missing table.

## Important implementation distinctions

- `finance_financial_accounts` represents bank, brokerage, cash, and card
  accounts. `finance_ledger_accounts` represents the general-ledger chart of
  accounts. They are separate tables with an explicit FK from the former to
  the latter.
- `finance_books` are book-scoped accounting boundaries, while
  `finance_entities` identify the legal/accounting owner. `workspaces` are
  access and tenancy boundaries; current compatibility SQL still links a
  workspace identity to the household foundation.
- `finance_tax_subjects` and `finance_tax_cases` are separate from workspaces,
  books, and entities. `finance_tax_case_grants` and `finance_tax_book_sources`
  preserve private case access and explicitly authorized book facts.

## SQL behavior outside the Drizzle graph

The snapshot records zero policy/RLS metadata for several tables even though
journaled SQL enables RLS and creates policies/triggers. The graph therefore
does not infer security or computed relations from snapshot omissions. Source-
side `1:1` labels use any declared unique key contained in the FK columns;
FK targets are checked against a complete exact primary/unique key. The
current SQL inventory reports `{custom_counts['tables']} table declarations` (including
`{len(custom['sqlOnlyTables'])}` SQL-only table outside the Drizzle table graph),
`{custom_counts['views']} views`, `{custom_counts['triggers']} triggers`,
`{custom_counts['policies']} policies`, and `{custom_counts['rls']} RLS operations`; review
`custom-sql-inventory.json` for migration provenance. SQL-only views such as
the investment lot-position projection are listed behavior metadata and are
not treated as base tables or authoritative FK endpoints.
"""


def build_layout(tables: list[dict[str, Any]]) -> dict[str, Any]:
    lane_gap = 590
    row_gap = 232
    node_width = 430
    visible_columns = 10
    domain_x = {domain: 45 + index * lane_gap for index, domain in enumerate(DOMAIN_ORDER)}
    domain_tables: dict[str, list[str]] = {domain: [] for domain in DOMAIN_ORDER}
    for table in tables:
        domain_tables[table["domain"]].append(table["key"])
    max_rows = 1
    for domain in DOMAIN_ORDER:
        domain_tables[domain].sort()
        for row, key in enumerate(domain_tables[domain]):
            table = next(table for table in tables if table["key"] == key)
            table["layout"] = {
                "x": domain_x[domain],
                "y": 88 + row * row_gap,
                "height": 66 + min(len(table["columns"]), visible_columns) * 16 + (18 if len(table["columns"]) > visible_columns else 0),
            }
            max_rows = max(max_rows, row + 1)
    return {
        "domainX": domain_x,
        "nodeWidth": node_width,
        "visibleColumns": visible_columns,
        "width": domain_x[DOMAIN_ORDER[-1]] + node_width + 90,
        "height": 88 + max_rows * row_gap + 90,
    }


def source_manifest(root: Path, journal: dict[str, Any], snapshot_path: Path) -> list[dict[str, Any]]:
    manifest: list[dict[str, Any]] = []
    for entry in journal["entries"]:
        tag = str(entry["tag"])
        path = root / "packages/db/drizzle" / f"{tag}.sql"
        manifest.append(
            {
                "idx": entry["idx"],
                "tag": tag,
                "path": str(path.relative_to(root)),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        )
    manifest.append(
        {
            "kind": "snapshot",
            "path": str(snapshot_path.relative_to(root)),
            "bytes": snapshot_path.stat().st_size,
            "sha256": sha256_file(snapshot_path),
        }
    )
    return manifest


def write_outputs(
    output: Path,
    payload: dict[str, Any],
    full_mmd: str,
    revision: str,
    snapshot_path: Path,
    journal_path: Path,
    snapshot_hash: str,
    journal_hash: str,
    manifest: list[dict[str, Any]],
    custom_inventory: dict[str, list[dict[str, str]]],
) -> None:
    output.mkdir(parents=True, exist_ok=True)
    (output / "domains").mkdir(parents=True, exist_ok=True)
    root_path = Path(payload["root"])
    custom_counts = {key: len(value) for key, value in custom_inventory.items()}
    custom_inventory_payload = {
        "source": "journaled migration SQL; inventory only",
        "drizzleSnapshotObjects": {
            "views": sorted(payload["snapshotViews"]),
            "tableRlsFlags": payload["snapshotRlsFlags"],
        },
        "objects": custom_inventory,
        "counts": custom_counts,
        "sqlOnlyViews": sorted(
            record["name"]
            for record in custom_inventory["views"]
            if record["name"] not in payload["snapshotViews"]
        ),
        "sqlOnlyTables": sorted(
            record["name"]
            for record in custom_inventory["tables"]
            if record["name"] not in {table["key"] for table in payload["tables"]}
        ),
        "sqlRlsTables": sorted({record["name"] for record in custom_inventory["rls"]}),
    }
    payload["customSql"] = custom_inventory_payload
    payload["schemaIndex"] = {
        "implementationRevision": revision,
        "snapshotPath": str(snapshot_path.relative_to(root_path)),
        "snapshotSha256": snapshot_hash,
        "journalPath": str(journal_path.relative_to(root_path)),
        "journalSha256": journal_hash,
        "migrationCount": len(manifest) - 1,
        "sourceManifest": manifest,
        "generator": "infra/scripts/generate-database-erd.py",
        "generatorSha256": sha256_file(root_path / "infra/scripts/generate-database-erd.py"),
        "counts": payload["counts"],
        "validation": payload["validation"],
    }
    schema_index = {
        "implementationRevision": revision,
        "source": payload["schemaIndex"],
        "domains": payload["domainTables"],
        "tables": payload["tables"],
        "foreignKeys": payload["fks"],
        "customSql": custom_inventory_payload,
    }
    (output / "schema-index.json").write_text(json.dumps(schema_index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output / "validation.json").write_text(json.dumps(payload["validation"], indent=2) + "\n", encoding="utf-8")
    (output / "custom-sql-inventory.json").write_text(json.dumps(custom_inventory_payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output / "database-erd.mmd").write_text(full_mmd, encoding="utf-8")
    (output / "database-erd.html").write_text(html_document(payload, full_mmd), encoding="utf-8")
    (output / "planned-gaps.md").write_text(planned_gaps(revision), encoding="utf-8")
    domain_index: list[str] = [f"# Domain diagrams — implementation revision {revision}", ""]
    for domain in DOMAIN_ORDER:
        stem = re.sub(r"[^a-z0-9]+", "-", domain.lower()).strip("-")
        (output / "domains" / f"{stem}.mmd").write_text(domain_mermaid(domain, payload["tables"], payload["fks"], revision), encoding="utf-8")
        (output / "domains" / f"{stem}.svg").write_text(domain_svg(domain, payload["tables"], payload["fks"], revision), encoding="utf-8")
        domain_index.append(f"- `{domain}`: [{stem}.svg]({stem}.svg) · [{stem}.mmd]({stem}.mmd)")
    (output / "domains" / "README.md").write_text("\n".join(domain_index) + "\n", encoding="utf-8")
    (output / "README.md").write_text(
        readme(
            revision,
            payload["counts"],
            payload["validation"],
            str(snapshot_path.relative_to(root_path)),
            snapshot_hash,
            str(journal_path.relative_to(root_path)),
            journal_hash,
            custom_inventory_payload,
        ),
        encoding="utf-8",
    )


def parse_args(root: Path) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=root, help="repository root")
    parser.add_argument("--snapshot", type=Path, help="Drizzle snapshot JSON, relative to root")
    parser.add_argument("--journal", type=Path, default=Path("packages/db/drizzle/meta/_journal.json"), help="Drizzle journal JSON, relative to root")
    parser.add_argument("--output", type=Path, default=Path("docs/architecture/database-erd"), help="artifact directory, relative to root")
    # Leave count guards opt-in so the no-argument command always follows the
    # latest journaled snapshot. CI or a handoff can pin expected counts with
    # explicit flags for a reproducible revision check.
    parser.add_argument("--expected-tables", type=int, default=None)
    parser.add_argument("--expected-fks", type=int, default=None)
    return parser.parse_args()


def main() -> int:
    run_generator_self_checks()
    script_root = Path(__file__).resolve().parents[2]
    args = parse_args(script_root)
    root = args.root.resolve()
    journal_path = (root / args.journal).resolve()
    journal = json.loads(journal_path.read_text(encoding="utf-8"))
    if not journal.get("entries"):
        raise SystemExit("Drizzle journal has no entries")
    last_tag = str(journal["entries"][-1]["tag"])
    snapshot_path = (root / args.snapshot).resolve() if args.snapshot else root / "packages/db/drizzle/meta" / f"{last_tag[:4]}_snapshot.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    tables, fks, counts = build_model(snapshot)
    validation = validate_model(tables, fks, args.expected_tables, args.expected_fks)
    if validation["errors"]:
        for error in validation["errors"]:
            print(f"error: {error}", file=sys.stderr)
        return 1
    inventory = parse_sql_inventory(root, journal["entries"])
    layout = build_layout(tables)
    revision = last_tag[:4]
    domain_tables = {domain: sorted(table["key"] for table in tables if table["domain"] == domain) for domain in DOMAIN_ORDER}
    payload: dict[str, Any] = {
        "revision": revision,
        "root": str(root),
        "domains": DOMAIN_ORDER,
        "colors": DOMAIN_COLORS,
        "domainTables": domain_tables,
        "layout": layout,
        "tables": tables,
        "fks": fks,
        "counts": counts,
        "validation": validation,
        "snapshotViews": sorted(snapshot.get("views", {}).keys()),
        "snapshotRlsFlags": {key: bool(value.get("isRLSEnabled", False)) for key, value in snapshot.get("tables", {}).items()},
    }
    full_mmd = full_mermaid(tables, fks, revision, counts)
    manifest = source_manifest(root, journal, snapshot_path)
    output = (root / args.output).resolve()
    write_outputs(
        output,
        payload,
        full_mmd,
        revision,
        snapshot_path,
        journal_path,
        sha256_file(snapshot_path),
        sha256_file(journal_path),
        manifest,
        inventory,
    )
    print(
        f"Generated {counts['tables']} tables, {counts['foreignKeys']} foreign keys, "
        f"and {len(inventory['triggers'])} SQL triggers at {output} (revision {revision})."
    )
    if validation["warnings"]:
        print(f"Warnings: {len(validation['warnings'])}; see validation.json.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
