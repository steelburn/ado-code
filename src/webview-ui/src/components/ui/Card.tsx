import React from "react"
import { cn } from "./cn"

export interface CardProps {
	title?: string
	actions?: React.ReactNode
	children: React.ReactNode
	className?: string
	style?: React.CSSProperties
}

export const Card: React.FC<CardProps> = ({ title, actions, children, className, style }) => {
	return (
		<div
			className={cn(className)}
			style={{
				background: "var(--vscode-editor-background)",
				border: "1px solid var(--vscode-panel-border)",
				borderRadius: 6,
				padding: 16,
				...style,
			}}
		>
			{(title || actions) && (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						marginBottom: 12,
						paddingBottom: 8,
						borderBottom: "1px solid var(--vscode-panel-border)",
					}}
				>
					{title && (
						<div
							style={{
								fontSize: "0.85em",
								fontWeight: 600,
								textTransform: "uppercase",
								letterSpacing: "0.5px",
								color: "var(--vscode-descriptionForeground)",
							}}
						>
							{title}
						</div>
					)}
					{actions && <div style={{ display: "flex", gap: 6 }}>{actions}</div>}
				</div>
			)}
			{children}
		</div>
	)
}
