/**
 * MAP rule 6 in UI form (spec 8): a surface whose upstream does not exist
 * yet says so, in plain English, naming what will fill it. No placeholder
 * cards, no sample rows, no "demo mode".
 */
export function EmptyState({ title, message }: { title?: string; message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-[520px] text-center">
        {title && <div className="mb-2 text-[13px] font-semibold text-foreground">{title}</div>}
        <p className="text-[12px] leading-relaxed text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
