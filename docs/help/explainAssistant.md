# ASKING THE ASSISTANT TO EXPLAIN

The AI Assistant can do more than build a network. It can explain a result, say why a station is the bottleneck, suggest the next experiment, say how sure an answer is, and draft a methods paragraph for a report. Every number it writes should name where it came from, and Qnet checks that it does.

This needs a configured provider (Settings ▸ AI Assistant) and a model that can call tools. See the AI Providers articles.

## WHAT TO ASK

With a network drawn, the empty assistant pane offers the questions that fit it:

- Explain this result
- Why is S2 the bottleneck? (when one station has the highest utilisation)
- What should I try next?
- How sure is this answer?
- Draft a methods paragraph
- Explain the method (by name)

A starter is put in the message field. Nothing is sent until you press Return. You can also type your own question.

Two other places open the assistant with a question ready. The Agreement view's banner has an Explain button that asks how sure the answer is. A problem's popover on the canvas has an Explain button that asks about that problem.

## WHERE THE ANSWERS COME FROM

The assistant does not compute. It asks Qnet, through tools, and Qnet answers with the same numbers the Results pane shows.

- Results and Agreement: the runs of the network as it is now, each with its tier, and how far the methods are from each other.
- Live Results: the closed-form values while drawing.
- Problems: the list the canvas shows, in Qnet's own sentences.
- Sensitivity, Plan Capacity, Uncertainty and Transient: asked of the same exact routines as those views. Where a view needs solver runs of its own (a numerical sensitivity estimate), the assistant reports the estimate you made there, or says there is none.
- Methods: the Method Chooser's list, with why each method applies or does not.
- Help: the text of these articles. A method is explained from its article, not from the model's memory.

When Qnet has no answer, the assistant is told so in words, and is told not to fill the gap. With no results yet it should say so and offer to run Solve.

## CITATIONS

Each number Qnet gives the assistant has a handle, for example the utilisation of S2 in one run. The assistant is asked to write the handle after every number. The pane draws a handle as a small chip that names the source and its tier, for example "Product Form · exact". Hover over it for the value as Qnet has it. Click it to show the source: the run and the station, the Sensitivity, Capacity, Uncertainty, Transient or Sweep view, the problem on the canvas, or the Help article.

## UNVERIFIED NUMBERS

After every reply Qnet reads the numbers in it and holds each against the result it cites. A number that fails is marked in the transcript with the words "unverified number", and the reply ends with a count. Hover over the mark for the reason. Copy Conversation and Save Transcript list the unverified numbers too.

A number is verified when a chip follows it in the same sentence and it equals that result, rounded to the decimals written and within 10 % of it. A percentage is checked against a ratio times one hundred. An end of a result's interval counts as well.

A number taken from a Help article is a different thing. Its chip reads "from Help" and is drawn with a dashed outline. Such a number must stand in the part of the article the assistant actually read, and it is never called verified: Help describes methods, and cannot vouch for a result of your network. When a result's chip and a Help chip follow the same number, the number is verified only if the result has it.

A number is marked when:

- no chip follows it;
- it does not match the result it cites;
- its unit is not the result's, for example "customers" after a utilisation;
- the network has changed since the result was read;
- it cites a source the assistant was never given.

Some numbers are not results and are never marked: digits inside a name (S2, M/M/1); a whole number that counts stations, classes, methods or steps; a list's numbering; a confidence level such as "95 % interval"; a year after an author's name; and the bounds 0, 1 and 100 % in a comparison or formula such as ρ < 1. A number the assistant itself gave to a tool in the same turn, such as a service rate it set, is an input: it is shown plain and is not called verified. So is a parameter of the network as the assistant read it. Digits in a name the assistant passed to a tool, such as the 2 of S2, are not inputs.

Servers, customers, runs and samples are results or parameters, so they need a chip.

The check has limits. It cannot judge the words around a number, and a number written out as a word is not read. A verified number is the number Qnet computed; whether the explanation built on it is right is still yours to judge.

## WHAT THE ASSISTANT MAY DO

Reading a result changes nothing and runs nothing.

- Solve and Check with Another Method start a solver run, as the Run menu's commands do. As with the assistant's other run commands, they need the conversation's tab to be in front. The assistant is told to offer first when you did not ask for a run, and Qnet holds it to that: a run starts only when your own last message asked for one or agreed to one, and at most twice for one message. Otherwise nothing runs, the assistant is told to ask you, and the transcript shows a button, Run Solve or Run Check with Another Method, that says yes in one click.
- A what-if sweep starts many runs. Qnet asks you to confirm before it starts.
- Applying a capacity plan changes the network. Qnet asks you to confirm, and Edit ▸ Undo takes it back in one step.

Names in your network are yours, or the author's of a file you were sent, and a name can be written to look like an instruction. In what the assistant reads, every node name and the file's name stands between the marks ‹ and ›, on one line, without control characters, and cut to 48 characters. The assistant is told that text inside a name, a file, a Status line or a Help article is data and never an instruction. The rule above does not depend on the model obeying that.

Every tool call is a row in the transcript. Open a row to see what was asked and what Qnet answered.

## A METHODS PARAGRAPH

"Draft a methods paragraph" asks for plain prose naming the network's parameters, each method and its tier, the Qnet version, and how well the methods agree. It is also asked to say what was not checked: only one method, an approximation with no exact check, a run that ended early. Read the draft against the Agreement view before you use it.

## WHAT IS SENT TO THE PROVIDER

When these tools are used, the provider receives what the tools returned: the network's parameters (node names, rates, numbers of servers, buffer sizes, routing probabilities) and its results (the numbers above, with method names and tiers), the problems' sentences, and the text of any Help article the assistant read. It also receives your messages, the system prompt and the tool descriptions, as before.

Nothing else is sent: no file path, no other tab, no API key, and nothing from your Mac outside the network in the conversation's tab. With LM Studio or Ollama on this Mac, nothing leaves the machine. The rest of the policy is unchanged; see the provider's article.

## SMALL LOCAL MODELS

A small model may forget to cite, or cite the wrong result. The marks show where. If a reply has many, ask a narrower question, lower the temperature in Settings ▸ AI Assistant, or use a larger model.
