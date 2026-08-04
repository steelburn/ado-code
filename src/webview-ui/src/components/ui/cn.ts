/**
 * Simple class name utility — filters falsy values and joins with spaces.
 * No external dependencies.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
	return classes.filter(Boolean).join(" ")
}
