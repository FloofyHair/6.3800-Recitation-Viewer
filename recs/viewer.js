import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url,
).href;

const problemList = document.querySelector("#problem-list");
const previousButton = document.querySelector("#previous");
const nextButton = document.querySelector("#next");
const recitationPicker = document.querySelector(".recitation-picker");
const recitationTrigger = document.querySelector("#recitation-trigger");
const recitationMenu = document.querySelector("#recitation-menu");
const recitationOptions = document.querySelector("#recitation-options");
const handoutLink = document.querySelector("#handout-link");
const solutionsLink = document.querySelector("#solutions-link");
const errorMessage = document.querySelector("#viewer-error");
const pdfDocuments = new Map();
const renderTasks = new WeakMap();
const renderPromises = new WeakMap();
const observedCanvases = new Set();
let activeRecitation = 1;
let generation = 0;
let nextSolutionId = 0;
let resizeTimer;

function selectRecitation(number) {
  renderRecitation(number);
}

function recitationFile(number, solutions = false) {
  const suffix = solutions ? "" : "-handout";
  return `rec${String(number).padStart(2, "0")}${suffix}.pdf`;
}

function clearCanvas(canvas) {
  const task = renderTasks.get(canvas);
  if (task) {
    task.cancel();
    renderTasks.delete(canvas);
  }
  canvas.width = 0;
  canvas.height = 0;
  canvas.removeAttribute("data-rendered");
}

function clearAllCanvases() {
  for (const canvas of observedCanvases) {
    clearCanvas(canvas);
    cropObserver.unobserve(canvas);
  }
  observedCanvases.clear();
}

function discardDocuments() {
  const documents = [...pdfDocuments.values()];
  pdfDocuments.clear();
  for (const entry of documents) {
    entry.loadingTask.destroy();
  }
}

async function getDocument(filename, renderGeneration) {
  if (renderGeneration !== generation) {
    return null;
  }

  let entry = pdfDocuments.get(filename);
  if (!entry) {
    const loadingTask = pdfjsLib.getDocument({
      url: filename,
      isEvalSupported: false,
      disableAutoFetch: true,
    });
    entry = { loadingTask, promise: loadingTask.promise };
    pdfDocuments.set(filename, entry);
    entry.promise.catch(() => {
      if (pdfDocuments.get(filename) === entry) {
        pdfDocuments.delete(filename);
      }
    });
  }

  const document = await entry.promise;
  if (renderGeneration !== generation || pdfDocuments.get(filename) !== entry) {
    return null;
  }
  return document;
}

function showRenderError(error, region) {
  if (error?.name === "RenderingCancelledException") {
    return;
  }
  console.error(`Could not render ${region.pdf}, page ${region.page}.`, error);
  errorMessage.hidden = false;
  errorMessage.textContent = `Could not render ${region.pdf}, page ${region.page}. Open the original PDF to view this section.`;
  const sourceLink = document.createElement("a");
  sourceLink.href = region.pdf;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener";
  sourceLink.textContent = " Open PDF";
  errorMessage.append(sourceLink);
}

function renderCrop(canvas) {
  const existingPromise = renderPromises.get(canvas);
  if (existingPromise) {
    return existingPromise;
  }
  const promise = renderCropNow(canvas);
  renderPromises.set(canvas, promise);
  const clearPromise = () => {
    if (renderPromises.get(canvas) === promise) {
      renderPromises.delete(canvas);
    }
  };
  promise.then(clearPromise, clearPromise);
  return promise;
}

async function renderCropNow(canvas) {
  if (!canvas.isConnected || canvas.dataset.rendered === "true") {
    return canvas.dataset.rendered === "true";
  }
  const solutionPanel = canvas.closest(".solution-panel");
  if (solutionPanel && solutionPanel.dataset.open !== "true") {
    return false;
  }

  const renderGeneration = generation;
  const region = JSON.parse(canvas.dataset.region);

  try {
    const document = await getDocument(region.pdf, renderGeneration);
    if (
      !document ||
      !canvas.isConnected ||
      renderGeneration !== generation ||
      (solutionPanel && solutionPanel.dataset.open !== "true")
    ) {
      return false;
    }

    const page = await document.getPage(region.page);
    if (
      !canvas.isConnected ||
      renderGeneration !== generation ||
      (solutionPanel && solutionPanel.dataset.open !== "true")
    ) {
      return false;
    }

    const [x0, y0, x1, y1] = region.rect;
    const cropWidth = x1 - x0;
    const cropHeight = y1 - y0;
    const cssWidth = canvas.parentElement.clientWidth;
    if (cssWidth <= 0 || cropWidth <= 0 || cropHeight <= 0) {
      return false;
    }

    const renderScale = Math.min(cssWidth / cropWidth, 2);
    const maxPixels = 3_000_000;
    const requestedPixelScale = Math.min(window.devicePixelRatio || 1, 2);
    const pixelScale = Math.min(
      requestedPixelScale,
      Math.sqrt(maxPixels / (cropWidth * cropHeight * renderScale ** 2)),
    );
    canvas.width = Math.ceil(cropWidth * renderScale * pixelScale);
    canvas.height = Math.ceil(cropHeight * renderScale * pixelScale);

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("The browser could not create a 2D canvas context.");
    }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const viewport = page.getViewport({ scale: renderScale });
    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: [
        pixelScale,
        0,
        0,
        pixelScale,
        -x0 * renderScale * pixelScale,
        -y0 * renderScale * pixelScale,
      ],
    });
    renderTasks.set(canvas, renderTask);
    await renderTask.promise;
    if (renderTasks.get(canvas) === renderTask) {
      renderTasks.delete(canvas);
      canvas.dataset.rendered = "true";
    }
    page.cleanup();
    return canvas.dataset.rendered === "true";
  } catch (error) {
    renderTasks.delete(canvas);
    clearCanvas(canvas);
    if (canvas.isConnected && renderGeneration === generation) {
      showRenderError(error, region);
    }
    return false;
  }
}

const cropObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const canvas = entry.target;
      if (entry.isIntersecting) {
        renderCrop(canvas);
      } else {
        clearCanvas(canvas);
      }
    }
  },
  { rootMargin: "320px 0px" },
);

function appendRegions(container, regions, label) {
  if (!regions.length) {
    return;
  }

  const pageGroup = document.createElement("div");
  pageGroup.className = "page-crops";
  for (const region of regions) {
    const figure = document.createElement("figure");
    const canvas = document.createElement("canvas");
    const cropWidth = region.rect[2] - region.rect[0];
    const cropHeight = region.rect[3] - region.rect[1];
    canvas.className = "pdf-crop";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${label}, page ${region.page}`);
    canvas.dataset.region = JSON.stringify(region);
    canvas.style.aspectRatio = `${cropWidth} / ${cropHeight}`;
    figure.append(canvas);
    pageGroup.append(figure);
    observedCanvases.add(canvas);
    cropObserver.observe(canvas);
  }
  container.append(pageGroup);
}

function appendAnswerToggle(container, part, problem) {
  const button = document.createElement("button");
  button.className = "solution-toggle";
  button.type = "button";
  const label = part.label
    ? `Show or hide answer for problem ${problem.number}${part.label}`
    : `Show or hide answer for problem ${problem.number}`;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);

  const panel = document.createElement("div");
  panel.className = "solution-panel";
  panel.id = `solution-${++nextSolutionId}`;
  panel.dataset.open = "false";
  panel.setAttribute("aria-hidden", "true");
  panel.inert = true;
  button.setAttribute("aria-controls", panel.id);
  button.setAttribute("aria-expanded", "false");

  const indicator = document.createElement("span");
  indicator.className = "indicator";
  indicator.setAttribute("aria-hidden", "true");
  button.append(indicator);

  const content = document.createElement("div");
  content.className = "solution-inner";
  panel.addEventListener("transitionend", (event) => {
    if (event.propertyName !== "height") {
      return;
    }
    if (panel.dataset.open === "true") {
      panel.style.height = "auto";
      return;
    }
    for (const canvas of panel.querySelectorAll("canvas")) {
      clearCanvas(canvas);
      cropObserver.observe(canvas);
    }
  });
  if (part.children) {
    for (const child of part.children) {
      appendRegions(
        content,
        child.solution,
        `Solution to problem ${problem.number}${part.label}${child.label}`,
      );
    }
  } else {
    appendRegions(content, part.solution, `Solution to problem ${problem.number}${part.label}`);
  }

  panel.append(content);
  button.addEventListener("click", async () => {
    const isOpen = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(isOpen));
    panel.dataset.open = String(isOpen);
    panel.setAttribute("aria-hidden", String(!isOpen));
    panel.inert = !isOpen;
    if (isOpen) {
      const canvases = [...panel.querySelectorAll("canvas")];
      for (const canvas of canvases) {
        cropObserver.unobserve(canvas);
      }
      await Promise.all(canvases.map(renderCrop));
      if (button.getAttribute("aria-expanded") !== "true") {
        for (const canvas of canvases) {
          clearCanvas(canvas);
          cropObserver.observe(canvas);
        }
        return;
      }
      panel.style.height = `${panel.scrollHeight}px`;
      for (const canvas of canvases) {
        cropObserver.observe(canvas);
      }
    } else {
      const canvases = [...panel.querySelectorAll("canvas")];
      for (const canvas of canvases) {
        cropObserver.unobserve(canvas);
      }
      const height = panel.getBoundingClientRect().height;
      panel.style.height = `${height}px`;
      panel.offsetHeight;
      panel.style.height = "0px";
      if (height === 0) {
        for (const canvas of canvases) {
          clearCanvas(canvas);
          cropObserver.observe(canvas);
        }
      }
    }
  });

  container.append(button, panel);
}

function renderRecitation(number) {
  generation += 1;
  clearAllCanvases();
  discardDocuments();

  activeRecitation = Math.min(window.RECITATION_DATA.length, Math.max(1, number));
  const recitation = window.RECITATION_DATA[activeRecitation - 1];
  recitationTrigger.textContent = `Recitation ${activeRecitation}`;
  recitationTrigger.setAttribute("aria-label", `Recitation ${activeRecitation}`);
  for (const option of recitationOptions.querySelectorAll(".recitation-option")) {
    option.setAttribute("aria-selected", String(Number(option.dataset.recitation) === activeRecitation));
  }
  previousButton.disabled = activeRecitation === 1;
  nextButton.disabled = activeRecitation === window.RECITATION_DATA.length;
  handoutLink.href = recitationFile(activeRecitation);
  solutionsLink.href = recitationFile(activeRecitation, true);
  errorMessage.hidden = true;
  problemList.replaceChildren();

  for (const problem of recitation.problems) {
    const card = document.createElement("article");
    card.className = "problem-card";

    const heading = document.createElement("header");
    heading.className = "problem-heading";
    const title = document.createElement("h2");
    title.textContent = `Problem ${problem.number}`;
    heading.append(title);
    card.append(heading);

    if (problem.context.length > 0) {
      const context = document.createElement("div");
      context.className = "problem-context";
      appendRegions(context, problem.context, `Context for problem ${problem.number}`);
      card.append(context);
    }

    for (const part of problem.subparts) {
      if (part.context) {
        const context = document.createElement("section");
        context.className = "part-context";
        appendRegions(context, part.context, `Context for problem ${problem.number}${part.label}`);
        card.append(context);
        if (!part.children) {
          continue;
        }
      }

      const subproblem = document.createElement("section");
      subproblem.className = "subproblem";
      const question = document.createElement("div");
      question.className = "question";
      if (part.children) {
        for (const child of part.children) {
          appendRegions(
            question,
            child.question,
            `Problem ${problem.number}${part.label}${child.label}`,
          );
        }
      } else {
        appendRegions(question, part.question, `Problem ${problem.number}${part.label}`);
      }
      subproblem.append(question);
      appendAnswerToggle(subproblem, part, problem);
      card.append(subproblem);
    }
    problemList.append(card);
  }
}

for (const recitation of window.RECITATION_DATA) {
  const option = document.createElement("button");
  option.className = "recitation-option";
  option.type = "button";
  option.setAttribute("role", "option");
  option.dataset.recitation = String(recitation.number);
  option.textContent = `Recitation ${recitation.number}`;
  option.addEventListener("click", () => {
    selectRecitation(recitation.number);
    setRecitationMenuOpen(false);
    recitationTrigger.focus();
  });
  recitationOptions.append(option);
}

function setRecitationMenuOpen(open, focusSelected = false) {
  recitationTrigger.setAttribute("aria-expanded", String(open));
  recitationMenu.hidden = !open;
  if (open && focusSelected) {
    recitationOptions.querySelector('[aria-selected="true"]')?.focus();
  }
}

recitationTrigger.addEventListener("click", () => {
  setRecitationMenuOpen(recitationMenu.hidden);
});
recitationTrigger.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    setRecitationMenuOpen(true, true);
  }
});
recitationOptions.addEventListener("keydown", (event) => {
  const options = [...recitationOptions.querySelectorAll(".recitation-option")];
  const currentIndex = options.indexOf(document.activeElement);
  let nextIndex;
  if (event.key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % options.length;
  } else if (event.key === "ArrowUp") {
    nextIndex = (currentIndex - 1 + options.length) % options.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = options.length - 1;
  } else if (event.key === "Escape") {
    event.preventDefault();
    setRecitationMenuOpen(false);
    recitationTrigger.focus();
    return;
  } else {
    return;
  }

  event.preventDefault();
  options[nextIndex].focus();
});
recitationPicker.addEventListener("focusout", () => {
  requestAnimationFrame(() => {
    if (!recitationPicker.contains(document.activeElement)) {
      setRecitationMenuOpen(false);
    }
  });
});
document.addEventListener("pointerdown", (event) => {
  if (!recitationPicker.contains(event.target)) {
    setRecitationMenuOpen(false);
  }
});
previousButton.addEventListener("click", () => selectRecitation(activeRecitation - 1));
nextButton.addEventListener("click", () => selectRecitation(activeRecitation + 1));

window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const visibleCanvases = [...observedCanvases].filter((canvas) => {
      const bounds = canvas.getBoundingClientRect();
      return bounds.bottom >= -320 && bounds.top <= window.innerHeight + 320;
    });
    for (const canvas of visibleCanvases) {
      clearCanvas(canvas);
      renderCrop(canvas);
    }
  }, 150);
});

renderRecitation(1);
