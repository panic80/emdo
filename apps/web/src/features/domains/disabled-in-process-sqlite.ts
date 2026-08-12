export default function disabledInProcessSqlite(): never {
  throw new Error(
    'In-process SQLite is disabled; EMDO requires the pinned encrypted worker.',
  );
}
