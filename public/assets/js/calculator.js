// public/assets/js/calculator.js

document.addEventListener("DOMContentLoaded", () => {
  const display = document.getElementById("calc-display");

  // Safely evaluate arithmetic expression without eval or Function()
  function safeEvaluate(expr) {
    // Replace math symbols
    expr = expr.replace(/×/g, "*").replace(/÷/g, "/");

    // Validate only safe math characters
    if (!/^[0-9+\-*/.() ]+$/.test(expr)) throw new Error("Invalid characters");

    // Tokenize and evaluate using Function-free math parser
    const stack = [];
    const output = [];
    const precedence = { "+": 1, "-": 1, "*": 2, "/": 2 };

    const tokens = expr.match(/[+\-*/()]|\d+(\.\d+)?/g);
    if (!tokens) throw new Error("Empty expression");

    for (const t of tokens) {
      if (!isNaN(t)) output.push(parseFloat(t));
      else if (t in precedence) {
        while (
          stack.length &&
          precedence[stack[stack.length - 1]] >= precedence[t]
        )
          output.push(stack.pop());
        stack.push(t);
      } else if (t === "(") stack.push(t);
      else if (t === ")") {
        while (stack.length && stack[stack.length - 1] !== "(")
          output.push(stack.pop());
        stack.pop(); // remove "("
      }
    }
    while (stack.length) output.push(stack.pop());

    const resultStack = [];
    for (const token of output) {
      if (typeof token === "number") resultStack.push(token);
      else {
        const b = resultStack.pop();
        const a = resultStack.pop();
        switch (token) {
          case "+": resultStack.push(a + b); break;
          case "-": resultStack.push(a - b); break;
          case "*": resultStack.push(a * b); break;
          case "/": resultStack.push(a / b); break;
        }
      }
    }
    const result = resultStack.pop();
    if (result === undefined || isNaN(result)) throw new Error("Bad expression");
    return result;
  }

  // Number & operator buttons
  document.querySelectorAll("[data-val]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-val");
      const lastChar = display.value.slice(-1);
      const ops = ["+", "-", "*", "/", "."];
      if (ops.includes(lastChar) && ops.includes(value)) return;
      display.value += value;
    });
  });

  // Clear
  document.getElementById("calc-clear")?.addEventListener("click", () => {
    display.value = "";
  });

  // Equal
  document.getElementById("calc-equal")?.addEventListener("click", () => {
    try {
      const result = safeEvaluate(display.value);
      display.value = result;
    } catch (err) {
      display.value = "ERR";
      console.error("Calculator error:", err);
    }
  });
});
