export function removeSvgComments(body) {
  let previous;
  do {
    previous = body;
    body = body.replace(/<!--[\s\S]*?-->/g, "");
  } while (body !== previous);
  return body;
}
