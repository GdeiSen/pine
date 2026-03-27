import { cn } from '@/lib/utils'

interface BadgeProps {
  children: React.ReactNode
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'accent' | 'live'
  className?: string
}

export function Badge({ children, variant = 'default', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold tracking-wide uppercase',
        variant === 'default' && 'bg-[--bg-subtle] text-[--text-secondary]',
        variant === 'success' && 'bg-emerald-500/10 text-emerald-500',
        variant === 'warning' && 'bg-amber-500/10 text-amber-500',
        variant === 'danger'  && 'bg-red-500/10 text-red-500',
        variant === 'accent'  && 'bg-[--color-accent-muted] text-[--color-accent]',
        variant === 'live'    && 'bg-[--color-accent] text-white',
        className,
      )}
    >
      {children}
    </span>
  )
}
