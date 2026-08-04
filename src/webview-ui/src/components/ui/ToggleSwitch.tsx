import React from "react"

export interface ToggleSwitchProps {
	checked: boolean
	onChange: () => void
	label?: string
	disabled?: boolean
	"aria-label"?: string
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
	checked,
	onChange,
	label,
	disabled = false,
	"aria-label": ariaLabel,
}) => {
	const width = 32
	const height = 18
	const dotSize = 14

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault()
			if (!disabled) onChange()
		}
	}

	const switchEl = (
		<div
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel || label}
			tabIndex={disabled ? -1 : 0}
			style={{
				width,
				height,
				backgroundColor: checked
					? "var(--vscode-button-background)"
					: "var(--vscode-button-secondaryBackground)",
				borderRadius: height / 2,
				position: "relative",
				cursor: disabled ? "not-allowed" : "pointer",
				transition: "background-color 0.2s",
				opacity: disabled ? 0.6 : 1,
				flexShrink: 0,
			}}
			onClick={disabled ? undefined : onChange}
			onKeyDown={handleKeyDown}
		>
			<div
				style={{
					width: dotSize,
					height: dotSize,
					backgroundColor: "var(--vscode-foreground)",
					borderRadius: "50%",
					position: "absolute",
					top: (height - dotSize) / 2,
					left: checked ? width - dotSize - (height - dotSize) / 2 : (height - dotSize) / 2,
					transition: "left 0.2s",
				}}
			/>
		</div>
	)

	if (!label) return switchEl

	return (
		<label
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				cursor: disabled ? "not-allowed" : "pointer",
				fontSize: "var(--vscode-font-size)",
				color: "var(--vscode-foreground)",
			}}
		>
			{switchEl}
			<span>{label}</span>
		</label>
	)
}
