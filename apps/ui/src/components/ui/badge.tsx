import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-none w-fit whitespace-nowrap shrink-0 gap-1",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        running: "border-transparent bg-[color-mix(in_srgb,var(--color-running)_16%,transparent)] text-[var(--color-running)]",
        success: "border-transparent bg-[color-mix(in_srgb,var(--color-success)_16%,transparent)] text-[var(--color-success)]",
        fail: "border-transparent bg-[color-mix(in_srgb,var(--color-fail)_16%,transparent)] text-[var(--color-fail)]",
        warning: "border-transparent bg-[color-mix(in_srgb,var(--color-warning)_16%,transparent)] text-[var(--color-warning)]",
        dim: "border-transparent bg-transparent text-muted-foreground px-0",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
