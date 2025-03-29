const { chromium } = require("playwright");
const { execSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: "",
});

// Required for file management and context storage
const contextDir = path.join(__dirname, "context");
const screenshotsDir = path.join(__dirname, "screenshots");

// Ensure directories exist
if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

class UniversalBrowserAgent {
  constructor(options = {}) {
    this.userDataDir = options.userDataDir || "C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data";
    this.chromePath = options.chromePath || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    this.browser = null;
    this.page = null;

    // Path to the context JSON file
    this.contextFile = path.join(contextDir, "agent-context.json");

    // Initialize context
    this.context = {
      objective: "",
      currentStep: 0,
      steps: [],
      urls: [],
      errors: [],
      extractedData: {},
    };

    // Load context if exists
    this.loadContext();
  }

  // Context management
  loadContext() {
    try {
      if (fs.existsSync(this.contextFile)) {
        this.context = JSON.parse(fs.readFileSync(this.contextFile, "utf8"));
        console.log("Loaded existing context");
      }
    } catch (error) {
      console.error("Error loading context:", error.message);
    }
  }

  saveContext() {
    try {
      fs.writeFileSync(this.contextFile, JSON.stringify(this.context, null, 2), "utf8");
    } catch (error) {
      console.error("Error saving context:", error.message);
    }
  }

  async initialize() {
    try {
      // Close any existing Chrome instances (Windows-specific)
      try {
        execSync("taskkill /IM chrome.exe /F");
        console.log("Closed existing Chrome instances.");
      } catch (err) {
        console.log("No Chrome instances were running.");
      }

      // Wait briefly to ensure Chrome fully closes
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Launch Chrome with the user profile - KEPT EXACTLY AS IN ORIGINAL CODE
      this.browser = await chromium.launchPersistentContext(this.userDataDir, {
        executablePath: this.chromePath,
        headless: false,
        args: ["--no-first-run", "--disable-notifications"],
      });

      // Open a new page (tab)
      this.page = await this.browser.newPage();

      console.log("Browser initialized successfully");

      // Set default timeout to be more lenient
      this.page.setDefaultTimeout(30000);

      // Track URL changes
      this.page.on("framenavigated", async (frame) => {
        if (frame === this.page.mainFrame()) {
          const newUrl = this.page.url();

          // Record URL change in context
          this.context.urls.push({
            step: this.context.currentStep,
            url: newUrl,
            timestamp: new Date().toISOString(),
          });

          console.log(`URL changed to: ${newUrl}`);

          // Save context after URL change
          this.saveContext();
        }
      });

      return true;
    } catch (error) {
      console.error("Error initializing browser:", error.message);
      return false;
    }
  }

  // Capture screenshot with step number
  async captureScreenshot() {
    const stepDir = path.join(screenshotsDir, `step-${this.context.currentStep}`);
    if (!fs.existsSync(stepDir)) fs.mkdirSync(stepDir, { recursive: true });

    const timestamp = Date.now();
    const filename = `screenshot-${timestamp}.png`;
    const filepath = path.join(stepDir, filename);

    await this.page.screenshot({ path: filepath, fullPage: true });
    console.log(`Screenshot captured: ${filepath}`);

    return filepath;
  }

  // Safe DOM extraction that avoids undefined properties
  async extractDOM() {
    try {
      const domData = await this.page.evaluate(() => {
        // Function to safely get text
        function safeGetText(element) {
          try {
            if (!element) return "";
            const text = element.innerText || element.textContent;
            return text ? text.trim() : "";
          } catch (e) {
            return "";
          }
        }

        // Function to safely get attribute
        function safeGetAttribute(element, attr) {
          try {
            if (!element || !attr) return "";
            const value = element.getAttribute(attr);
            return value ? value : "";
          } catch (e) {
            return "";
          }
        }

        // Function to check if element is reasonably visible
        function isVisible(element) {
          try {
            if (!element || !element.getBoundingClientRect) return false;

            const style = window.getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              return false;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth && rect.bottom > 0 && rect.right > 0;
          } catch (e) {
            return false;
          }
        }

        // Function to get accessible name (for better element identification)
        function getAccessibleName(element) {
          try {
            // Check aria-label first
            let name = element.getAttribute("aria-label");
            if (name) return name;

            // Check for label association
            if (element.id) {
              const label = document.querySelector(`label[for="${element.id}"]`);
              if (label) return safeGetText(label);
            }

            // Check for inner text
            if (element.tagName !== "INPUT" && element.tagName !== "SELECT" && element.tagName !== "TEXTAREA") {
              name = safeGetText(element);
              if (name) return name;
            }

            // Check for placeholder or value as fallback
            return element.placeholder || element.value || "";
          } catch (e) {
            return "";
          }
        }

        // Get basic page information
        const pageInfo = {
          title: document.title,
          url: window.location.href,
          h1Texts: Array.from(document.querySelectorAll("h1")).map((el) => safeGetText(el)),
          h2Texts: Array.from(document.querySelectorAll("h2")).map((el) => safeGetText(el)),
          mainText: safeGetText(document.body).substring(0, 500),
        };

        // Get all potentially interactive elements
        const interactiveElements = [];

        // Common interactive elements by tag
        const interactiveTags = ["a", "button", "input", "select", "textarea", "summary", "details", "label", "option"];

        // Common interactive elements by role
        const interactiveRoles = [
          "button",
          "link",
          "checkbox",
          "radio",
          "combobox",
          "listbox",
          "menuitem",
          "menuitemcheckbox",
          "menuitemradio",
          "option",
          "switch",
          "tab",
          "treeitem",
          "searchbox",
          "textbox",
        ];

        // Process elements by tag
        interactiveTags.forEach((tag) => {
          document.querySelectorAll(tag).forEach((el) => {
            if (isVisible(el) && !el.disabled) {
              const boundingBox = el.getBoundingClientRect();

              interactiveElements.push({
                tag: el.tagName.toLowerCase(),
                type: safeGetAttribute(el, "type"),
                id: el.id || "",
                name: safeGetAttribute(el, "name"),
                accessibleName: getAccessibleName(el),
                text: safeGetText(el),
                placeholder: safeGetAttribute(el, "placeholder"),
                value: el.value || "",
                href: safeGetAttribute(el, "href"),
                ariaLabel: safeGetAttribute(el, "aria-label"),
                ariaRole: safeGetAttribute(el, "role"),
                classes: el.className || "",
                required: el.hasAttribute("required"),
                disabled: el.hasAttribute("disabled") || safeGetAttribute(el, "aria-disabled") === "true",
                bounds: {
                  top: boundingBox.top,
                  left: boundingBox.left,
                  width: boundingBox.width,
                  height: boundingBox.height,
                  bottom: boundingBox.bottom,
                  right: boundingBox.right,
                },
              });
            }
          });
        });

        // Process elements by ARIA role
        interactiveRoles.forEach((role) => {
          document.querySelectorAll(`[role="${role}"]`).forEach((el) => {
            // Skip if already added by tag
            if (isVisible(el) && !el.disabled && !interactiveElements.some((e) => e.id === el.id && el.id !== "")) {
              const boundingBox = el.getBoundingClientRect();

              interactiveElements.push({
                tag: el.tagName.toLowerCase(),
                type: safeGetAttribute(el, "type"),
                id: el.id || "",
                name: safeGetAttribute(el, "name"),
                accessibleName: getAccessibleName(el),
                text: safeGetText(el),
                placeholder: safeGetAttribute(el, "placeholder"),
                value: el.value || "",
                href: safeGetAttribute(el, "href"),
                ariaLabel: safeGetAttribute(el, "aria-label"),
                ariaRole: role,
                classes: el.className || "",
                required: el.hasAttribute("required"),
                disabled: el.hasAttribute("disabled") || safeGetAttribute(el, "aria-disabled") === "true",
                bounds: {
                  top: boundingBox.top,
                  left: boundingBox.left,
                  width: boundingBox.width,
                  height: boundingBox.height,
                  bottom: boundingBox.bottom,
                  right: boundingBox.right,
                },
              });
            }
          });
        });

        // Find any clickable div/span with onclick handlers or pointer cursor
        document.querySelectorAll("div, span").forEach((el) => {
          if (isVisible(el)) {
            const style = window.getComputedStyle(el);
            const hasClickHandler = el.onclick || el.getAttribute("onclick");
            const isClickable = style.cursor === "pointer";

            if (hasClickHandler || isClickable) {
              const boundingBox = el.getBoundingClientRect();

              interactiveElements.push({
                tag: el.tagName.toLowerCase(),
                type: "clickable",
                id: el.id || "",
                accessibleName: getAccessibleName(el),
                text: safeGetText(el),
                ariaLabel: safeGetAttribute(el, "aria-label"),
                ariaRole: safeGetAttribute(el, "role"),
                classes: el.className || "",
                bounds: {
                  top: boundingBox.top,
                  left: boundingBox.left,
                  width: boundingBox.width,
                  height: boundingBox.height,
                  bottom: boundingBox.bottom,
                  right: boundingBox.right,
                },
              });
            }
          }
        });

        // Get error and success messages
        const messages = {
          errors: [],
          success: [],
        };

        // Common error selectors (keeping generic, not application-specific)
        const errorSelectors = [".error", '[role="alert"]', ".alert", ".notification", '*[class*="error"i]', '*[class*="danger"i]', '*[class*="fail"i]', '*[aria-invalid="true"]'];

        document.querySelectorAll(errorSelectors.join(",")).forEach((el) => {
          if (isVisible(el)) {
            const text = safeGetText(el);
            if (text) {
              // Check if it's likely an error message by looking for error-related words
              const isLikelyError = /error|fail|invalid|denied|wrong|incorrect|bad|not allowed|cannot|problem/i.test(text);
              if (isLikelyError) {
                messages.errors.push({
                  text,
                  bounds: el.getBoundingClientRect(),
                });
              }
            }
          }
        });

        // Common success selectors
        const successSelectors = [".success", ".info-message", ".confirmation", '*[class*="success"i]', '*[class*="confirm"i]', '*[class*="info"i]'];

        document.querySelectorAll(successSelectors.join(",")).forEach((el) => {
          if (isVisible(el)) {
            const text = safeGetText(el);
            if (text) {
              // Check if it's likely a success message
              const isLikelySuccess = /success|thank|complet|confirm|done|created|updated|saved/i.test(text);
              if (isLikelySuccess) {
                messages.success.push({
                  text,
                  bounds: el.getBoundingClientRect(),
                });
              }
            }
          }
        });

        return {
          pageInfo,
          interactiveElements,
          messages,
        };
      });

      return domData;
    } catch (error) {
      console.error("Error extracting DOM:", error.message);
      return {
        pageInfo: { title: "Error", url: this.page.url() },
        interactiveElements: [],
        messages: { errors: [{ text: error.message }], success: [] },
      };
    }
  }

  // Generate selectors based on element properties (universal approach)
  generateSelectors(element) {
    const selectors = [];

    // ID selector (highest priority)
    if (element.id) {
      selectors.push({ type: "css", selector: `#${element.id}` });
    }

    // Data attributes (common in modern web apps)
    ["data-testid", "data-test", "data-id", "data-automation"].forEach((attr) => {
      const dataAttr = `data-${attr.replace("data-", "")}`;
      if (element[dataAttr]) {
        selectors.push({ type: "css", selector: `[${dataAttr}="${element[dataAttr]}"]` });
      }
    });

    // Accessible name (via aria-label)
    if (element.ariaLabel) {
      selectors.push({ type: "css", selector: `[aria-label="${element.ariaLabel}"]` });
    }

    // Role selectors
    if (element.ariaRole) {
      if (element.accessibleName) {
        // Role + accessible name is very reliable
        selectors.push({
          type: "xpath",
          selector: `//*[@role="${element.ariaRole}"][contains(text(),"${element.accessibleName}")]`,
        });
      } else {
        selectors.push({ type: "css", selector: `[role="${element.ariaRole}"]` });
      }
    }

    // Name attribute
    if (element.name) {
      selectors.push({ type: "css", selector: `[name="${element.name}"]` });
    }

    // Tag + text for buttons, links, etc.
    if (element.text && element.tag) {
      selectors.push({
        type: "text",
        selector: element.text,
      });

      // XPath with exact text
      selectors.push({
        type: "xpath",
        selector: `//${element.tag}[normalize-space(.)="${element.text}"]`,
      });

      // XPath with contains
      selectors.push({
        type: "xpath",
        selector: `//${element.tag}[contains(.,"${element.text}")]`,
      });
    }

    // Placeholder for inputs
    if (element.placeholder) {
      selectors.push({ type: "css", selector: `[placeholder="${element.placeholder}"]` });
    }

    // Href for links (but only if it's not too generic)
    if (element.href && !["#", "/", ""].includes(element.href)) {
      selectors.push({ type: "css", selector: `[href="${element.href}"]` });
    }

    // Combination selectors for more specificity
    if (element.tag && element.classes) {
      const classes = element.classes
        .split(" ")
        .filter((c) => c.length > 0)
        .map((c) => c.trim());

      if (classes.length > 0) {
        // Use the first class as it's often the most specific
        selectors.push({ type: "css", selector: `${element.tag}.${classes[0]}` });
      }
    }

    // Positional selector (last resort)
    if (element.bounds) {
      selectors.push({
        type: "position",
        bounds: element.bounds,
      });
    }

    return selectors;
  }

  // Try multiple selectors with robust error handling
  async findElement(selectors) {
    for (const selector of selectors) {
      try {
        let element;

        switch (selector.type) {
          case "css":
            element = await this.page.$(selector.selector);
            break;

          case "text":
            element = await this.page.getByText(selector.selector, { exact: false }).first();
            break;

          case "xpath":
            element = await this.page.$(`xpath=${selector.selector}`);
            break;

          case "position":
            // Find element at the specified position
            element = await this.page.evaluateHandle((bounds) => {
              // Find all elements at this point
              const elements = document.elementsFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);

              // Filter for likely interactive elements
              for (const el of elements) {
                const tag = el.tagName.toLowerCase();
                const style = window.getComputedStyle(el);

                // Check if it's a naturally interactive element
                if (["a", "button", "input", "select", "textarea"].includes(tag)) {
                  return el;
                }

                // Check for role attributes
                if (el.getAttribute("role") && ["button", "link", "checkbox", "radio"].includes(el.getAttribute("role"))) {
                  return el;
                }

                // Check if it has a click handler or pointer cursor
                if (el.onclick || style.cursor === "pointer") {
                  return el;
                }
              }

              // Return the top element if nothing else matched
              return elements[0];
            }, selector.bounds);
            break;
        }

        if (element) {
          // Validate the element is interactive and visible
          const isValid = await this.page.evaluate((el) => {
            if (!el) return false;

            // Check visibility
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              return false;
            }

            // Check size
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) {
              return false;
            }

            return true;
          }, element);

          if (isValid) {
            console.log(`Found element using selector: ${selector.type} - ${selector.selector || "position"}`);
            return element;
          }
        }
      } catch (error) {
        // Just log and continue to next selector
        console.log(`Selector ${selector.type} failed: ${error.message}`);
      }
    }

    return null;
  }

  // Vision-based page analysis
  async analyzePageWithVision(screenshot) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `You are a universal browser automation assistant analyzing a web page screenshot.

Your objective is: "${this.context.objective}"

Analyze this screenshot and provide:
1. What website/page am I looking at? (Type, purpose, key features)
2. What are the main interactive elements I can see?
3. What would be the next logical step to take toward my objective?

Be specific about what UI elements you see, but avoid any application-specific assumptions. Describe elements by their visual appearance and apparent function.`,
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: fs.readFileSync(screenshot).toString("base64"),
                },
              },
            ],
          },
        ],
      });

      const analysis = response.content[0].text;
      console.log(`Page analysis: ${analysis.substring(0, 200)}...`);

      return analysis;
    } catch (error) {
      console.error("Error analyzing page with vision:", error.message);
      return "Error analyzing page with vision.";
    }
  }

  // Determine next action based on vision analysis and DOM data
  async determineNextAction(visionAnalysis, domData) {
    try {
      // Format interactive elements for better readability
      const elementsText = domData.interactiveElements
        .map((el, i) => {
          let desc = `${i}: <${el.tag}>`;

          // Add most important attributes for identification
          const attributes = [];
          if (el.accessibleName) attributes.push(`accessibleName="${el.accessibleName}"`);
          if (el.text) attributes.push(`text="${el.text}"`);
          if (el.ariaLabel) attributes.push(`aria-label="${el.ariaLabel}"`);
          if (el.ariaRole) attributes.push(`role="${el.ariaRole}"`);
          if (el.placeholder) attributes.push(`placeholder="${el.placeholder}"`);
          if (el.type) attributes.push(`type="${el.type}"`);
          if (el.id) attributes.push(`id="${el.id}"`);

          desc += " " + attributes.join(" ");

          // Position info
          if (el.bounds) {
            desc += ` [x:${Math.round(el.bounds.left)}, y:${Math.round(el.bounds.top)}, w:${Math.round(el.bounds.width)}, h:${Math.round(el.bounds.height)}]`;
          }

          return desc;
        })
        .join("\n");

      // Format error and success messages
      const errorText = domData.messages.errors.length > 0 ? `Error messages:\n${domData.messages.errors.map((e) => e.text).join("\n")}` : "No error messages detected.";

      const successText = domData.messages.success.length > 0 ? `Success messages:\n${domData.messages.success.map((s) => s.text).join("\n")}` : "No success messages detected.";

      // Context from previous steps
      const stepsContext =
        this.context.steps.length > 0
          ? `Previous steps:\n${this.context.steps.map((step, i) => `${i + 1}. ${step.action} - ${step.description}\n   Result: ${step.result || "No result"}`).join("\n")}`
          : "No previous steps taken.";

      const response = await anthropic.messages.create({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `You are a universal browser automation agent. Based on the current page state, determine the next action to take to achieve the objective.

Current objective: ${this.context.objective}
Current URL: ${domData.pageInfo.url}
Page title: ${domData.pageInfo.title}

Visual analysis:
${visionAnalysis}

Available interactive elements:
${elementsText}

${errorText}
${successText}

${stepsContext}

Determine the most appropriate next action to take. Return your response in JSON format:
{
  "action": "click" | "fill" | "navigate" | "extract" | "complete" | "waitAndRetry",
  "description": "Description of what you're trying to do",
  "elementIndex": null, // Index of the element to interact with (if applicable)
  "value": null, // For fill actions only
  "isComplete": false, // Whether the objective is complete or not
  "extractedData": null // Any data extracted from the page (if applicable)
}

For element selection, refer to the exact element index from the list above. If you cannot find an appropriate element, use "waitAndRetry" action.`,
          },
        ],
      });

      // Parse the response to get the action
      const responseText = response.content[0].text;
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        try {
          const actionData = JSON.parse(jsonMatch[0]);
          return actionData;
        } catch (jsonError) {
          console.error("Error parsing JSON from response:", jsonError);
          return { action: "error", description: "Could not parse action response" };
        }
      } else {
        console.error("No JSON found in response:", responseText);
        return { action: "error", description: "No structured action found" };
      }
    } catch (error) {
      console.error("Error determining next action:", error.message);
      return { action: "error", description: "Error communicating with Anthropic API" };
    }
  }

  // Execute the recommended action with universal approach
  async executeAction(actionData, domData) {
    try {
      // Log what we're about to do
      console.log(`Executing action: ${actionData.action} - ${actionData.description}`);

      // Record this step in our history
      const stepRecord = {
        step: this.context.currentStep,
        action: actionData.action,
        description: actionData.description,
        timestamp: new Date().toISOString(),
      };

      // If objective is complete, extract the data and finish
      if (actionData.action === "complete" || actionData.isComplete) {
        console.log("Objective complete!");

        if (actionData.extractedData) {
          console.log(`Extracted data: ${JSON.stringify(actionData.extractedData)}`);
          this.context.extractedData = actionData.extractedData;
        }

        stepRecord.result = "Objective complete";
        this.context.steps.push(stepRecord);
        this.saveContext();

        return { success: true, data: this.context.extractedData };
      }

      // Otherwise execute the specified action
      let actionResult;

      switch (actionData.action) {
        case "click": {
          if (actionData.elementIndex !== undefined && actionData.elementIndex !== null) {
            const element = domData.interactiveElements[actionData.elementIndex];

            if (element) {
              console.log(`Target element: ${element.tag} "${element.text || element.accessibleName || ""}" at [${Math.round(element.bounds?.left || 0)}, ${Math.round(element.bounds?.top || 0)}]`);

              // Generate selectors for this element (universal approach)
              const selectors = this.generateSelectors(element);

              // Try to find the element with multiple selector strategies
              const elementHandle = await this.findElement(selectors);

              if (elementHandle) {
                try {
                  // Scroll element into view first
                  await elementHandle.scrollIntoViewIfNeeded();

                  // Try standard click first
                  await elementHandle.click({ timeout: 5000 });
                  actionResult = "Click successful";
                } catch (clickError) {
                  console.warn(`Standard click failed: ${clickError.message}, trying alternatives...`);

                  try {
                    // Force click as first alternative
                    await elementHandle.click({ force: true, timeout: 3000 });
                    actionResult = "Click successful with force option";
                  } catch (forceClickError) {
                    console.warn(`Force click failed: ${forceClickError.message}, trying JS click...`);

                    try {
                      // JavaScript click as second alternative
                      await this.page.evaluate((el) => {
                        el.click();
                      }, elementHandle);
                      actionResult = "Click successful via JS click()";
                    } catch (jsClickError) {
                      console.warn(`JS click failed: ${jsClickError.message}, trying mouse position...`);

                      // Get the bounding box for the element
                      const boundingBox = await elementHandle.boundingBox().catch(() => element.bounds);

                      if (boundingBox) {
                        const x = boundingBox.x + boundingBox.width / 2;
                        const y = boundingBox.y + boundingBox.height / 2;

                        // Mouse click at position
                        await this.page.mouse.click(x, y);
                        actionResult = "Click successful via mouse position";
                      } else {
                        throw new Error("Could not get element position for click");
                      }
                    }
                  }
                }
              } else {
                // Last resort: try using a more general selector based on text content
                if (element.text) {
                  try {
                    await this.page.locator(`text="${element.text}"`).click({ timeout: 3000 });
                    actionResult = "Click successful via text content";
                  } catch (textClickError) {
                    throw new Error(`Could not click element with any method: ${textClickError.message}`);
                  }
                } else {
                  throw new Error("Could not find element with any selector");
                }
              }
            } else {
              throw new Error(`No element at index ${actionData.elementIndex}`);
            }
          } else {
            throw new Error("No element index specified for click action");
          }
          break;
        }

        case "fill": {
          if (actionData.elementIndex !== undefined && actionData.elementIndex !== null && actionData.value) {
            const element = domData.interactiveElements[actionData.elementIndex];

            if (element) {
              console.log(
                `Target element for input: ${element.tag} "${element.placeholder || element.accessibleName || ""}" at [${Math.round(element.bounds?.left || 0)}, ${Math.round(
                  element.bounds?.top || 0
                )}]`
              );

              // Generate selectors for this element
              const selectors = this.generateSelectors(element);

              // Try to find the element with multiple selector strategies
              const elementHandle = await this.findElement(selectors);

              if (elementHandle) {
                try {
                  // Scroll into view first
                  await elementHandle.scrollIntoViewIfNeeded();

                  // Clear existing value for input fields
                  if (element.tag === "input" || element.tag === "textarea") {
                    await elementHandle.fill("");
                  }

                  // Try standard fill approach
                  await elementHandle.fill(actionData.value);
                  actionResult = `Filled with: "${actionData.value}"`;
                } catch (fillError) {
                  console.warn(`Standard fill failed: ${fillError.message}, trying alternatives...`);

                  try {
                    // Try typing character by character
                    await elementHandle.click();
                    await this.page.keyboard.type(actionData.value);
                    actionResult = `Typed with keyboard: "${actionData.value}"`;
                  } catch (typeError) {
                    console.warn(`Keyboard typing failed: ${typeError.message}, trying JS value...`);

                    // Try setting value directly with JavaScript
                    await this.page.evaluate(
                      (el, value) => {
                        el.value = value;
                        // Trigger input event to ensure validation happens
                        const event = new Event("input", { bubbles: true });
                        el.dispatchEvent(event);
                        // Also trigger change event
                        const changeEvent = new Event("change", { bubbles: true });
                        el.dispatchEvent(changeEvent);
                      },
                      elementHandle,
                      actionData.value
                    );

                    actionResult = `Set value via JavaScript: "${actionData.value}"`;
                  }
                }
              } else {
                // Try by placeholder as last resort
                if (element.placeholder) {
                  try {
                    await this.page.locator(`[placeholder="${element.placeholder}"]`).fill(actionData.value);
                    actionResult = `Filled by placeholder: "${actionData.value}"`;
                  } catch (placeholderFillError) {
                    throw new Error(`Could not fill element with any method: ${placeholderFillError.message}`);
                  }
                } else {
                  throw new Error("Could not find input element with any selector");
                }
              }
            } else {
              throw new Error(`No element at index ${actionData.elementIndex}`);
            }
          } else {
            throw new Error("Missing element index or value for fill action");
          }
          break;
        }

        case "navigate":
          if (actionData.value) {
            // Make sure URL is properly formatted
            let url = actionData.value;
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
              url = "https://" + url;
            }

            await this.page.goto(url, { waitUntil: "domcontentloaded" });
            actionResult = `Navigated to: ${url}`;

            // Wait for page to settle after navigation
            try {
              await this.page.waitForLoadState("networkidle", { timeout: 15000 });
            } catch (loadError) {
              console.log("Network didn't reach idle state, but continuing");
            }
          } else {
            throw new Error("No URL provided for navigate action");
          }
          break;

        case "extract":
          if (actionData.extractedData) {
            this.context.extractedData = actionData.extractedData;
            actionResult = `Extracted data: ${JSON.stringify(actionData.extractedData)}`;
          } else {
            // Try to extract data based on the objective
            try {
              // Look for repository URLs if that's part of the objective
              if (this.context.objective.toLowerCase().includes("repository") && (this.context.objective.toLowerCase().includes("url") || this.context.objective.toLowerCase().includes("link"))) {
                const urls = await this.page.evaluate(() => {
                  const result = {};
                  // Look for SSH URLs
                  const sshElements = Array.from(document.querySelectorAll('input[value*="git@"], [aria-label*="SSH"], [data-tab-item*="ssh"]'));
                  if (sshElements.length > 0) {
                    for (const el of sshElements) {
                      if (el.tagName === "INPUT" && el.value && el.value.includes("git@")) {
                        result.ssh = el.value;
                        break;
                      }
                      // Check if there's a related code element with the URL
                      const codeElements = Array.from(el.querySelectorAll("code, span"));
                      for (const code of codeElements) {
                        if (code.textContent && code.textContent.includes("git@")) {
                          result.ssh = code.textContent.trim();
                          break;
                        }
                      }
                    }
                  }

                  // Look for HTTPS URLs
                  const httpsElements = Array.from(document.querySelectorAll('input[value*="https://"], [aria-label*="HTTPS"], [data-tab-item*="https"]'));
                  if (httpsElements.length > 0) {
                    for (const el of httpsElements) {
                      if (el.tagName === "INPUT" && el.value && el.value.includes("https://")) {
                        result.https = el.value;
                        break;
                      }
                      // Check related code elements
                      const codeElements = Array.from(el.querySelectorAll("code, span"));
                      for (const code of codeElements) {
                        if (code.textContent && code.textContent.includes("https://")) {
                          result.https = code.textContent.trim();
                          break;
                        }
                      }
                    }
                  }

                  return result;
                });

                if (urls.ssh || urls.https) {
                  this.context.extractedData = urls;
                  actionResult = `Extracted repository URLs: ${JSON.stringify(urls)}`;
                } else {
                  actionResult = "No data extracted";
                }
              } else {
                actionResult = "No data extracted";
              }
            } catch (extractError) {
              console.warn(`Error during data extraction: ${extractError.message}`);
              actionResult = "Error extracting data";
            }
          }
          break;

        case "waitAndRetry":
          // Wait for a moment and then try again
          await new Promise((resolve) => setTimeout(resolve, 3000));
          actionResult = "Waited for page to settle";
          break;

        case "error":
          throw new Error(`Action error: ${actionData.description}`);

        default:
          throw new Error(`Unknown action type: ${actionData.action}`);
      }

      // Record the result
      stepRecord.result = actionResult;
      this.context.steps.push(stepRecord);

      // Increment step counter
      this.context.currentStep++;

      // Save updated context
      this.saveContext();

      // Brief pause to allow page to stabilize
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Wait for network to be idle after action
      await this.page.waitForLoadState("networkidle").catch((e) => {
        console.log("Network did not reach idle state:", e.message);
      });

      return { success: true, result: actionResult };
    } catch (error) {
      console.error("Error executing action:", error.message);

      // Record the failed step
      this.context.steps.push({
        step: this.context.currentStep,
        action: actionData.action,
        description: actionData.description,
        result: `Error: ${error.message}`,
        timestamp: new Date().toISOString(),
      });

      // Record error
      this.context.errors.push({
        step: this.context.currentStep,
        action: actionData.action,
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      // Increment step counter even on failure
      this.context.currentStep++;

      // Save updated context
      this.saveContext();

      return { success: false, error: error.message };
    }
  }

  async executeTask(objective) {
    try {
      // Set the task objective
      this.context.objective = objective;
      this.context.currentStep = 0;
      this.context.steps = [];
      this.context.urls = [];
      this.context.errors = [];
      this.context.extractedData = {};

      console.log(`Starting task: ${objective}`);
      this.saveContext();

      // Maximum steps to prevent infinite loops
      const maxSteps = 30;

      while (this.context.currentStep < maxSteps) {
        // Capture screenshot
        const screenshot = await this.captureScreenshot();

        // Extract DOM data
        const domData = await this.extractDOM();

        // Vision analysis
        const visionAnalysis = await this.analyzePageWithVision(screenshot);

        // Determine next action
        const nextAction = await this.determineNextAction(visionAnalysis, domData);

        // Execute action
        const result = await this.executeAction(nextAction, domData);

        // Check if task is complete
        if (nextAction.action === "complete" || nextAction.isComplete) {
          return {
            success: true,
            message: "Task completed successfully",
            data: this.context.extractedData,
            steps: this.context.steps,
          };
        }

        // If we hit a critical error threshold
        if (this.context.errors.length > 5) {
          return {
            success: false,
            message: "Too many errors, stopping execution",
            errors: this.context.errors,
            steps: this.context.steps,
          };
        }

        // Brief pause between actions
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      return {
        success: false,
        message: "Maximum steps reached without completing task",
        steps: this.context.steps,
      };
    } catch (error) {
      console.error("Error executing task:", error.message);
      return {
        success: false,
        error: error.message,
        steps: this.context.steps,
      };
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log("Browser closed");
    }
  }
}

// Example usage
async function main() {
  const agent = new UniversalBrowserAgent();
  await agent.initialize();

  // Example task - can be any browser automation objective
  const result = await agent.executeTask("Create a new GitHub repository named 'test-repo-xyz123' and return its SSH/HTTPS URL");

  console.log("Task result:", JSON.stringify(result, null, 2));

  // Close the browser when done
  await agent.close();
}

// Run the example
main().catch(console.error);
