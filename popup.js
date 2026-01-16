const api = typeof browser !== "undefined" ? browser : chrome;

async function getPrograms() {
  const { inboxPrograms = [] } = await api.storage.local.get("inboxPrograms");
  return inboxPrograms;
}

async function setPrograms(programs) {
  await api.storage.local.set({ inboxPrograms: programs });
}

function parsePrograms(text) {
  return text
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
}

async function loadProgramSelect() {
  const select = document.getElementById("programSelect");
  const programs = await getPrograms();

  if (!programs.length) {
    select.innerHTML = `<option value="">No programs configured</option>`;
    return;
  }

  select.innerHTML = programs
    .map(inbox => `<option value="${inbox}">${inbox}</option>`)
    .join("");
}

document.getElementById("managePrograms").onclick = async () => {
  const editor = document.getElementById("programEditor");
  const saveBtn = document.getElementById("savePrograms");

  const showing = editor.style.display !== "none";
  editor.style.display = showing ? "none" : "block";
  saveBtn.style.display = showing ? "none" : "block";

  if (!showing) {
    const programs = await getPrograms();
    editor.value = programs.join("\n");
  }
};

document.getElementById("savePrograms").onclick = async () => {
  const raw = document.getElementById("programEditor").value;
  const programs = parsePrograms(raw);

  await setPrograms(programs);
  await loadProgramSelect();

  document.getElementById("programEditor").style.display = "none";
  document.getElementById("savePrograms").style.display = "none";
};

document.addEventListener("DOMContentLoaded", loadProgramSelect);


document.getElementById("go").addEventListener("click", async () => {
  const inbox = document.getElementById("programSelect").value;
  const start = document.getElementById("start").value;
  const end = document.getElementById("end").value;

  if (!inbox || !start || !end) {
    alert("Inbox and date range required");
    return;
  }

  await api.runtime.sendMessage({
    type: "BEGIN_SCRAPE_FROM_INBOX",
    inbox,
    startDate: start,
    endDate: end
  });

  window.close();
});
