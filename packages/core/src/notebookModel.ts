/**
 * Notebook model — mirrors the minimal structure of the .ipynb JSON format so the
 * rest of the system can work with a typed in-memory representation rather than
 * raw JSON objects everywhere.
 */

export type CellType = "code" | "markdown" | "raw";

export interface OutputItem {
  /** MIME type, e.g. "text/plain", "text/html", "image/png", "application/json" */
  mimeType: string;
  /** Raw text or base-64 string depending on mimeType */
  data: string;
}

export interface CellOutput {
  outputType: "stream" | "display_data" | "execute_result" | "error";
  /** Present for stream outputs */
  name?: "stdout" | "stderr";
  /** Present for stream / plain text outputs */
  text?: string;
  /** Present for rich / display outputs */
  items?: OutputItem[];
  /** Present for error outputs */
  ename?: string;
  evalue?: string;
  traceback?: string[];
  /** Execution count for execute_result */
  executionCount?: number | null;
}

export interface NotebookCell {
  /** Stable identifier — generated when mapping from a script block if not present */
  id: string;
  cellType: CellType;
  source: string;
  outputs: CellOutput[];
  executionCount: number | null;
  /** Arbitrary metadata carried through from .ipynb, preserved on round-trips */
  metadata: Record<string, unknown>;
}

export interface NotebookMetadata {
  kernelspec?: {
    displayName: string;
    language: string;
    name: string;
  };
  languageInfo?: {
    name: string;
    version?: string;
  };
  /** Additional .ipynb notebook-level metadata passed through unchanged */
  extra: Record<string, unknown>;
}

export interface Notebook {
  /** Colab/Drive file id, or a local path, or a session-scoped uri */
  uri: string;
  metadata: NotebookMetadata;
  cells: NotebookCell[];
  /** nbformat from the spec — 4 for all modern notebooks */
  nbformat: number;
  nbformatMinor: number;
}

// ---------------------------------------------------------------------------
// Serialisation helpers — convert between the typed Notebook model and the
// raw JSON structure of .ipynb files.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawIpynb = Record<string, any>;

/** Convert a raw parsed .ipynb JSON object into a typed Notebook. */
export function deserializeNotebook(raw: RawIpynb): Notebook {
  const cells: NotebookCell[] = ((raw["cells"] as RawIpynb[]) ?? []).map(
    (rawCell, idx) => {
      const source = Array.isArray(rawCell["source"])
        ? (rawCell["source"] as string[]).join("")
        : String(rawCell["source"] ?? "");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outputs: CellOutput[] = ((rawCell["outputs"] as any[]) ?? []).map(
        deserializeCellOutput
      );

      return {
        id:
          typeof rawCell["id"] === "string" && rawCell["id"]
            ? rawCell["id"]
            : `cell-${idx}`,
        cellType: (rawCell["cell_type"] as CellType) ?? "code",
        source,
        outputs,
        executionCount:
          rawCell["execution_count"] !== undefined
            ? (rawCell["execution_count"] as number | null)
            : null,
        metadata:
          typeof rawCell["metadata"] === "object" && rawCell["metadata"] !== null
            ? (rawCell["metadata"] as Record<string, unknown>)
            : {},
      };
    }
  );

  const rawMeta: RawIpynb =
    typeof raw["metadata"] === "object" && raw["metadata"] !== null
      ? (raw["metadata"] as RawIpynb)
      : {};

  const ks = rawMeta["kernelspec"] as RawIpynb | undefined;
  const li = rawMeta["language_info"] as RawIpynb | undefined;

  const { kernelspec: _ks, language_info: _li, ...extraMeta } = rawMeta;

  return {
    uri: "",
    nbformat: (raw["nbformat"] as number) ?? 4,
    nbformatMinor: (raw["nbformat_minor"] as number) ?? 5,
    metadata: {
      ...(ks
        ? {
            kernelspec: {
              displayName: String(ks["display_name"] ?? ""),
              language: String(ks["language"] ?? "python"),
              name: String(ks["name"] ?? "python3"),
            },
          }
        : {}),
      ...(li
        ? {
            languageInfo: {
              name: String(li["name"] ?? "python"),
              ...(li["version"] ? { version: String(li["version"]) } : {}),
            },
          }
        : {}),
      extra: extraMeta as Record<string, unknown>,
    },
    cells,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deserializeCellOutput(raw: RawIpynb): CellOutput {
  const outputType = String(raw["output_type"] ?? "stream") as CellOutput["outputType"];

  const textFromField = (field: unknown): string | undefined => {
    if (Array.isArray(field)) return (field as string[]).join("");
    if (typeof field === "string") return field;
    return undefined;
  };

  if (outputType === "stream") {
    const text = textFromField(raw["text"]);
    return {
      outputType,
      name: (raw["name"] as "stdout" | "stderr") ?? "stdout",
      ...(text !== undefined ? { text } : {}),
    };
  }

  if (outputType === "error") {
    return {
      outputType,
      ename: String(raw["ename"] ?? ""),
      evalue: String(raw["evalue"] ?? ""),
      traceback: Array.isArray(raw["traceback"])
        ? (raw["traceback"] as string[])
        : [],
    };
  }

  // display_data or execute_result
  const data = (raw["data"] as Record<string, unknown>) ?? {};
  const items: OutputItem[] = Object.entries(data).map(([mimeType, value]) => ({
    mimeType,
    data: Array.isArray(value)
      ? (value as string[]).join("")
      : String(value ?? ""),
  }));

  return {
    outputType,
    items,
    ...(outputType === "execute_result"
      ? { executionCount: (raw["execution_count"] as number | null) ?? null }
      : {}),
  };
}

/** Convert a typed Notebook back into a raw .ipynb-compatible JSON object. */
export function serializeNotebook(nb: Notebook): RawIpynb {
  const cells = nb.cells.map((cell) => {
    const rawCell: RawIpynb = {
      id: cell.id,
      cell_type: cell.cellType,
      source: cell.source,
      metadata: cell.metadata,
      outputs: cell.outputs.map(serializeCellOutput),
      execution_count: cell.executionCount,
    };
    return rawCell;
  });

  const rawMeta: RawIpynb = { ...nb.metadata.extra };
  if (nb.metadata.kernelspec) {
    rawMeta["kernelspec"] = {
      display_name: nb.metadata.kernelspec.displayName,
      language: nb.metadata.kernelspec.language,
      name: nb.metadata.kernelspec.name,
    };
  }
  if (nb.metadata.languageInfo) {
    rawMeta["language_info"] = {
      name: nb.metadata.languageInfo.name,
      ...(nb.metadata.languageInfo.version
        ? { version: nb.metadata.languageInfo.version }
        : {}),
    };
  }

  return {
    nbformat: nb.nbformat,
    nbformat_minor: nb.nbformatMinor,
    metadata: rawMeta,
    cells,
  };
}

function serializeCellOutput(output: CellOutput): RawIpynb {
  if (output.outputType === "stream") {
    return {
      output_type: "stream",
      name: output.name ?? "stdout",
      text: output.text ?? "",
    };
  }
  if (output.outputType === "error") {
    return {
      output_type: "error",
      ename: output.ename ?? "",
      evalue: output.evalue ?? "",
      traceback: output.traceback ?? [],
    };
  }
  const data: Record<string, string> = {};
  for (const item of output.items ?? []) {
    data[item.mimeType] = item.data;
  }
  return {
    output_type: output.outputType,
    data,
    metadata: {},
    ...(output.outputType === "execute_result"
      ? { execution_count: output.executionCount ?? null }
      : {}),
  };
}
