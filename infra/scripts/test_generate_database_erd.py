"""Cardinality regressions for the snapshot-based ERD generator.

Run: python3 -m unittest discover -s infra/scripts -p 'test_generate_database_erd.py'
"""

import importlib.util
from pathlib import Path
import unittest
import tempfile


spec = importlib.util.spec_from_file_location(
    "database_erd", Path(__file__).with_name("generate-database-erd.py")
)
assert spec and spec.loader
erd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(erd)


class SourceCardinalityTests(unittest.TestCase):
    def test_composite_primary_key_members_are_visible_in_table_and_columns(self):
        tables, _, _ = erd.build_model({"tables": {"emdo.example": {
            "columns": {
                "workspace_id": {"type": "uuid", "notNull": True},
                "id": {"type": "uuid", "notNull": True},
                "enabled": {"type": "boolean", "default": False},
                "attempts": {"type": "integer", "default": 0},
            },
            "compositePrimaryKeys": {"example_pk": {"columns": ["workspace_id", "id"]}},
        }}})
        table = tables[0]
        self.assertEqual(table["primaryKey"], ["workspace_id", "id"])
        columns = {column["name"]: column for column in table["columns"]}
        self.assertTrue(columns["workspace_id"]["primaryKey"])
        self.assertTrue(columns["id"]["primaryKey"])
        self.assertFalse(columns["enabled"]["primaryKey"])
        self.assertIs(columns["enabled"]["default"], False)
        self.assertEqual(columns["attempts"]["default"], 0)

    def test_unique_key_order_does_not_change_cardinality(self):
        table = {"uniqueConstraints": {"key": {"columns": ["workspace_id", "id"]}}}
        self.assertTrue(erd.is_unique_columns(table, ["id", "workspace_id"]))

    def test_foreign_key_containing_primary_key_is_unique(self):
        table = {"columns": {"id": {"primaryKey": True}, "workspace_id": {}}}
        self.assertTrue(erd.is_unique_columns(table, ["workspace_id", "id"]))

    def test_subset_of_composite_key_is_not_unique(self):
        table = {"compositePrimaryKeys": {"key": {"columns": ["workspace_id", "id"]}}}
        self.assertFalse(erd.is_unique_columns(table, ["workspace_id"]))

    def test_empty_key_is_not_unique(self):
        self.assertFalse(erd.is_unique_columns({}, []))

    def test_plain_unconditional_unique_index_is_a_unique_key(self):
        table = {"columns": {"id": {}, "workspace_id": {}}, "indexes": {"key": {
            "isUnique": True,
            "columns": [{"expression": "id", "isExpression": False}],
        }}}
        self.assertTrue(erd.is_unique_columns(table, ["workspace_id", "id"]))

    def test_partial_expression_and_nonunique_indexes_do_not_prove_cardinality(self):
        for extra in (
            {"where": "active = true"},
            {"columns": [{"expression": "lower(id)", "isExpression": True}]},
            {"isUnique": False},
        ):
            with self.subTest(extra=extra):
                table = {"columns": {"id": {}}, "indexes": {"key": {
                    "isUnique": True,
                    "columns": [{"expression": "id", "isExpression": False}],
                    **extra,
                }}}
                self.assertFalse(erd.is_unique_columns(table, ["id"]))


class SqlTriggerInventoryTests(unittest.TestCase):
    def test_deferred_constraints_are_inventoried_without_dynamic_placeholders(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            migrations = root / "packages/db/drizzle"
            migrations.mkdir(parents=True)
            (migrations / "0060_example.sql").write_text("""
CREATE CONSTRAINT TRIGGER complete_snapshot AFTER INSERT ON emdo.forecasts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION emdo.complete();
CREATE TRIGGER guard BEFORE INSERT ON "emdo"."budgets"
  FOR EACH ROW EXECUTE FUNCTION emdo.guard();
EXECUTE format('CREATE TRIGGER a_lock_book BEFORE INSERT ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock()', table_name);
""", encoding="utf-8")
            inventory = erd.parse_sql_inventory(root, [{"tag": "0060_example"}])
            self.assertEqual({(item["name"], item["table"]) for item in inventory["triggers"]}, {
                ("complete_snapshot", "emdo.forecasts"), ("guard", "emdo.budgets"),
            })


if __name__ == "__main__":
    unittest.main()
