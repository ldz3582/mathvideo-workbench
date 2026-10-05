/**
 * Animath Institute · 白色学术风与数学几何流场
 * 纯白学术论文与坐标系背景上的动态几何演算
 */
(() => {
	"use strict";

	const canvas = document.createElement("canvas");
	canvas.id = "academic-math-canvas";
	canvas.style.position = "fixed";
	canvas.style.inset = "0";
	canvas.style.width = "100vw";
	canvas.style.height = "100vh";
	canvas.style.pointerEvents = "none";
	canvas.style.zIndex = "0";
	canvas.style.opacity = "0.85";
	document.body.prepend(canvas);

	const ctx = canvas.getContext("2d");
	let width = (canvas.width = window.innerWidth);
	let height = (canvas.height = window.innerHeight);

	window.addEventListener("resize", () => {
		width = canvas.width = window.innerWidth;
		height = canvas.height = window.innerHeight;
	});

	const MOUSE = { x: width * 0.5, y: height * 0.5, targetX: width * 0.5, targetY: height * 0.5, active: false };
	window.addEventListener("mousemove", (e) => {
		MOUSE.targetX = e.clientX;
		MOUSE.targetY = e.clientY;
		MOUSE.active = true;
	});

	// LaTeX 学术符号粒子池（牛津墨水深蓝/石板灰配色）
	const MATH_SYMBOLS = [
		"\\nabla \\times \\mathbf{B}",
		"e^{i\\pi} + 1 = 0",
		"\\oint_C f(z)dz = 0",
		"\\sum_{n=1}^\\infty \\frac{1}{n^s}",
		"\\int_{-\\infty}^\\infty e^{-x^2}dx = \\sqrt{\\pi}",
		"\\partial_\\mu F^{\\mu\\nu} = J^\\nu",
		"\\mathbb{R}^n \\to \\mathbb{C}",
		"\\mathcal{L}\\{f(t)\\}",
		"\\hat{f}(\\xi) = \\int f(x)e^{-2\\pi i x \\xi}dx",
		"\\det(A - \\lambda I) = 0",
		"\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1",
		"\\text{Q.E.D.} \\blacksquare",
		"\\chi(M) = 2 - 2g",
		"\\zeta(2) = \\frac{\\pi^2}{6}",
		"ds^2 = -c^2dt^2 + dx^2",
	];

	class MathParticle {
		constructor() {
			this.reset(true);
		}
		reset(initial = false) {
			this.x = Math.random() * width;
			this.y = initial ? Math.random() * height : height + 20;
			this.vx = (Math.random() - 0.5) * 0.35;
			this.vy = -(Math.random() * 0.35 + 0.15);
			this.symbol = MATH_SYMBOLS[Math.floor(Math.random() * MATH_SYMBOLS.length)];
			this.alpha = 0;
			this.maxAlpha = Math.random() * 0.28 + 0.15;
			this.size = Math.random() * 3 + 12.5; // 12.5px ~ 15.5px
			this.rot = (Math.random() - 0.5) * 0.15;
			this.rotSpeed = (Math.random() - 0.5) * 0.002;
			this.phase = Math.random() * Math.PI * 2;
			this.color = Math.random() > 0.6 ? "rgba(37, 99, 235," : Math.random() > 0.5 ? "rgba(180, 83, 9," : "rgba(15, 23, 42,";
		}
		update(t) {
			this.x += this.vx + Math.sin(t * 0.001 + this.phase) * 0.25;
			this.y += this.vy;
			this.rot += this.rotSpeed;

			// 鼠标学术引力场
			if (MOUSE.active) {
				const dx = this.x - MOUSE.x;
				const dy = this.y - MOUSE.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				if (dist < 180 && dist > 1) {
					const force = (1 - dist / 180) * 0.8;
					this.x += (dx / dist) * force;
					this.y += (dy / dist) * force;
				}
			}

			if (this.y < height * 0.8 && this.alpha < this.maxAlpha) {
				this.alpha += 0.006;
			}
			if (this.y < 90) {
				this.alpha -= 0.008;
			}
			if (this.y < 0 || (this.alpha <= 0 && this.y < height * 0.5)) {
				this.reset();
			}
		}
		draw(ctx) {
			if (this.alpha <= 0) return;
			ctx.save();
			ctx.translate(this.x, this.y);
			ctx.rotate(this.rot);
			ctx.fillStyle = `${this.color} ${this.alpha})`;
			ctx.font = `italic ${this.size}px "EB Garamond", "Cinzel", "STIX Two Text", "Times New Roman", serif`;
			ctx.fillText(this.symbol, 0, 0);
			ctx.restore();
		}
	}

	const particles = Array.from({ length: 26 }, () => new MathParticle());

	// 动态傅里叶波与 Lissajous 谐振轨道（纯白学术墨水风格）
	function drawHarmonicWaves(t) {
		const time = t * 0.0008;

		// 1. 傅里叶主谐波波动 (Fourier Summation Wave - Royal Cobalt Blue)
		ctx.save();
		ctx.beginPath();
		ctx.lineWidth = 1.3;
		ctx.strokeStyle = "rgba(37, 99, 235, 0.16)";
		const baseY = height * 0.65;

		for (let x = 0; x <= width; x += 6) {
			const normX = (x / width) * Math.PI * 4;
			const harm1 = Math.sin(normX + time * 1.5) * 36;
			const harm2 = (1 / 3) * Math.sin(normX * 3 - time * 2.1) * 36;
			const harm3 = (1 / 5) * Math.sin(normX * 5 + time * 0.9) * 36;
			const y = baseY + harm1 + harm2 + harm3;
			if (x === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();

		// 2. 伴随黄金分割谐波 (Golden Amber Wave)
		ctx.beginPath();
		ctx.lineWidth = 1.1;
		ctx.strokeStyle = "rgba(180, 83, 9, 0.14)";
		for (let x = 0; x <= width; x += 8) {
			const normX = (x / width) * Math.PI * 3.236;
			const y = baseY + 18 + Math.sin(normX - time * 1.2) * 24 + Math.cos(normX * 1.618 + time) * 14;
			if (x === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();

		// 3. 右上角 Lissajous 参数化几何轨道 (Lissajous Resonance Curve)
		const centerX = width - 180;
		const centerY = 160;
		const radiusA = 70;
		const radiusB = 55;
		const a = 3;
		const b = 4;
		const delta = time * 0.8;

		ctx.beginPath();
		ctx.strokeStyle = "rgba(37, 99, 235, 0.18)";
		ctx.lineWidth = 1.2;
		for (let theta = 0; theta <= Math.PI * 2; theta += 0.05) {
			const lx = centerX + radiusA * Math.sin(a * theta + delta);
			const ly = centerY + radiusB * Math.sin(b * theta);
			if (theta === 0) ctx.moveTo(lx, ly);
			else ctx.lineTo(lx, ly);
		}
		ctx.closePath();
		ctx.stroke();

		// 轨道当前相位的切线点
		const curX = centerX + radiusA * Math.sin(a * time + delta);
		const curY = centerY + radiusB * Math.sin(b * time);
		ctx.beginPath();
		ctx.arc(curX, curY, 3.5, 0, Math.PI * 2);
		ctx.fillStyle = "#2563eb";
		ctx.fill();

		ctx.restore();
	}

	// 鼠标跟随坐标切线与微积分标尺
	function drawMouseTangent() {
		if (!MOUSE.active) return;
		ctx.save();
		MOUSE.x += (MOUSE.targetX - MOUSE.x) * 0.1;
		MOUSE.y += (MOUSE.targetY - MOUSE.y) * 0.1;

		ctx.strokeStyle = "rgba(37, 99, 235, 0.14)";
		ctx.lineWidth = 1;
		ctx.setLineDash([3, 5]);

		// X / Y 十字极轴
		ctx.beginPath();
		ctx.moveTo(MOUSE.x - 30, MOUSE.y);
		ctx.lineTo(MOUSE.x + 30, MOUSE.y);
		ctx.moveTo(MOUSE.x, MOUSE.y - 30);
		ctx.lineTo(MOUSE.x, MOUSE.y + 30);
		ctx.stroke();

		// 极坐标原点微环
		ctx.beginPath();
		ctx.setLineDash([]);
		ctx.arc(MOUSE.x, MOUSE.y, 14, 0, Math.PI * 2);
		ctx.strokeStyle = "rgba(180, 83, 9, 0.25)";
		ctx.stroke();

		ctx.restore();
	}

	function animate(t) {
		ctx.clearRect(0, 0, width, height);

		drawHarmonicWaves(t);
		drawMouseTangent();

		for (const p of particles) {
			p.update(t);
			p.draw(ctx);
		}

		requestAnimationFrame(animate);
	}

	requestAnimationFrame(animate);
})();
