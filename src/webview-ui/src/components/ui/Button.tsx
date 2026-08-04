import React from "react"
import { cn } from "./cn"

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"
export type ButtonSize = "sm" | "md" | "lg"

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant
	size?: ButtonSize
	loading?: boolean
}

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
	primary: {
		background: "var(--vscode-button-background)",
		color: "var(--vscode-button-foreground)",
		border: "none",
		borderRadius: 6,
	},
	secondary: {
		background: "var(--vscode-button-secondaryBackground)",
		color: "var(--vscode-button-secondaryForeground)",
		border: "none",
		borderRadius: 6,
	},
	ghost: {
		background: "transparent",
		color: "var(--vscode-foreground)",
		border: "none",
		borderRadius: 3,
	},
	danger: {
		background: "var(--vscode-inputValidation-errorBackground)",
		color: "var(--vscode-inputValidation-errorForeground)",
		border: "1px solid var(--vscode-inputValidation-errorBorder)",
		borderRadius: 6,
	},
}

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
	sm: { padding: "4px 10px", fontSize: "0.85em" },
	md: { padding: "6px 16px", fontSize: "var(--vscode-font-size)" },
	lg: { padding: "8px 20px", fontSize: "1em", fontWeight: 500 },
}

export const Button: React.FC<ButtonProps> = ({
	variant = "secondary",
	size = "md",
	loading = false,
	disabled,
	className,
	style,
	children,
	...props
}) => {
	return (
		<button
			className={cn("btn", className)}
			style={{
				...variantStyles[variant],
				...sizeStyles[size],
				cursor: disabled || loading ? "not-allowed" : "pointer",
				opacity: disabled || loading ? 0.6 : 1,
				fontFamily: "var(--vscode-font-family)",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 6,
				outline: "none",
				transition: "opacity 0.15s, background 0.15s",
				whiteSpace: "nowrap",
				...style,
			}}
			disabled={disabled || loading}
			{...props}
		>
			{loading && (
				<span
					style={{
						display: "inline-block",
						width: 12,
						height: 12,
						border: "2px solid currentColor",
						borderTopColor: "transparent",
						borderRadius: "50%",
						animation: "spin 0.6s linear infinite",
					}}
				/>
			)}
			{children}
		</button>
	)
}
