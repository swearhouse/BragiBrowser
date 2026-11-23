export const $ = id => document.getElementById(id);

export function message(text) {
  $("status").textContent = text;
}

export function log(text) {
  const item = document.createElement("li");
  item.textContent = text;
  $("activity").prepend(item);
}
