import type { ReactNode } from "react"

export function CardTable({
  columns,
  rows,
}: {
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ReadonlyArray<string>>
}): ReactNode {
  return (
    <div className="overflow-x-auto rounded-xl bg-elevated hairline border-line-quaternary scrollbar-thin">
      <table className="w-full border-collapse text-start text-sm">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                key={index}
                scope="col"
                className="border-b border-line-secondary px-3 py-2 text-start font-medium whitespace-nowrap text-fg-secondary"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((_, column) => (
                <td key={column} className="border-b border-line-secondary px-3 py-2 break-words">
                  {row[column]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
