import React from "react"
import { cn } from "./cn"

export type BadgeVariant = "success" | "warning" | "error" | "info"

export interface BadgeProps {
	variant?: BadgeVariant
	children: React.ReactNode
	className?: string
}

const variantColors: Record<BadgeVariant, { bg: string; fg: string; border: string }> = {
	success: {
		bg: "var(--vscode-terminal-ansiGreen, #89d185)",
		fg: "#000",
		border: "var(--vscode-terminal-ansiGreen, #89d185)",
	},
	warning: {
		bg: "var(--vscode-terminal-ansiYellow, #cccc00)",
		fg: "#000",
		border: "var(--vscode-terminal-ansiYellow, #cccc00)",
	},
	error: {
		bg: "var(--vscode-inputValidation-errorBackground)",
		fg: "var(--vscode-inputValidation-errorForeground)",
		border: "var(--vscode-inputValidation-errorBorder)",
	},
	info: {
		bg: "var(--vscode-badge-background)",
		fg: "var(--vscode-badge-foreground)",
		border: "var(--vscode-badge-background)",
	},
}

export const Badge: React.FC<BadgeProps> = ({ variant = "info", children, className }) => {
	const colors = variantColors[variant]

	return (
		<span
			className={cn(className)}
			style={{
				display: "inline-block",
				padding: "1px 8px",
				fontSize: "0.75em",
				fontWeight: 500,
				lineHeight: 1.6,
				borderRadius: 10,
				background: colors.bg,
				color: colors.fg,
				border: `1px solid ${colors.border}`,
				whiteSpace: "nowrap",
			}}
		>
			{children}
		</span>
	)
}
