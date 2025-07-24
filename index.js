/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */
export default (app) => {


  app.on("pull_request.opened", async (context) => {
    app.log.info("Pull request opened");
    const prInfo = await getOwlcastPRInfoFromAPI(context);
    return context.octokit.issues.createComment(context.issue({
      body: prInfo
    }));
  });

  app.on("pull_request.edited", async (context) => {
    app.log.info("Pull request edited " + context.payload['pull_request']['number']);
    
    // Get all comments on the PR
    const comments = await context.octokit.issues.listComments(context.issue());
    
    // Find the last comment made by owlcast-bot
    const botComments = comments.data.filter(comment => 
      comment.user.login === 'owlcast-bot[bot]'
    );

    // Get the PR info from API
    const prInfo = await getOwlcastPRInfoFromAPI(context);

    app.log.info(prInfo);
    
    if (botComments.length > 0) {
      const lastBotComment = botComments[botComments.length - 1];
      
      // Update the last bot comment
      return context.octokit.issues.updateComment({
        ...context.repo(),
        comment_id: lastBotComment.id,
        body: prInfo
      });
    } else {
      // If no bot comments exist, create a new one
      return context.octokit.issues.createComment(context.issue({
        body: prInfo
      }));
    }
  });

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
};


async function getOwlcastPRInfoFromAPI(context) {
  const body = context.payload['pull_request']['body'];
  const number = context.payload['pull_request']['number'];
  let title = context.payload['pull_request']['title'];

  // Remove the percent status from the title
  const titlePercent = title.indexOf("[");
  if (titlePercent !== -1) {
      title = title.substring(0, titlePercent).trim();
  }

  const formattedTitle = `#${number} ${title}`;

  // Parse links using local functions
  const links = parsePrLinks(body);
  const description = parsePrDescription(body);
  
  // Determine missing info using AI
  const missingInfo = await determineMissingInfo(description, links, body);

  const prInfo = `
# What Owlcast Scraped

## ${formattedTitle}
Description: ${description}

Feature Flags: 
${links.feature_flags.map(link => `- ${link}`).join("\n")}

Loom Links:
${links.loom_links.map(link => `- ${link}`).join("\n")}

Live URLs: 
${links.live_urls.map(link => `- ${link}`).join("\n")}

Image URLs: 
${links.image_urls.map(link => `- ${link}`).join("\n")}

Missing Info:
${missingInfo}
    `

  return prInfo;
}

function parsePrLinks(body) {
  // Find the feature flags in the body
  // Returns the links to the feature flags, no names yet
  // only works for codehs
  const featureFlagMatches = body.match(/(?:https?:\/\/)?(?:www\.)?codehs\.com\/internal\/feature_flag\/\d+/g) || [];
  let feature_flags = featureFlagMatches.filter(link => link.startsWith('https://'));
  feature_flags = [...new Set(feature_flags)];

  // Find the loom links in the body
  const loomMatches = body.match(/(?:https?:\/\/)?(?:www\.)?loom\.com\/share\/[a-zA-Z0-9]+/g) || [];
  let loom_links = loomMatches.filter(link => link.startsWith('https://'));
  loom_links = [...new Set(loom_links)];

  // Trust that live urls are after the Live URLs: label
  const liveUrlsIndex = body.indexOf("Live URLs:");
  let live_urls = [];

  if (liveUrlsIndex !== -1) {
    const newlineIndex = body.indexOf('\n', liveUrlsIndex);
    const liveUrlsText = body.substring(newlineIndex).trim();
    // Remove hyphens and extract only the URLs
    const liveUrlMatches = liveUrlsText.match(/https:\/\/[^\s]+/g) || [];
    live_urls = liveUrlMatches.filter(link => link.startsWith('https://'));
    live_urls = [...new Set(live_urls)];
  }

  // Find image URLs in src attributes
  const imageMatches = body.match(/https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9-]+/g) || [];
  let image_urls = imageMatches.filter(link => link.startsWith('https://'));
  image_urls = [...new Set(image_urls)];

  return {
    feature_flags,
    loom_links,
    live_urls,
    image_urls
  };
}

function parsePrDescription(body) {
  // Find the label in the text add 1 to ignore the colon in case it exists
  const labelIndex = body.indexOf("Description") + 1;
  let description = "";
  let startIndex;

  if (labelIndex === 0) {
    // if there is no description, search for the first line that is not empty
    startIndex = 0;
  } else {
    // Get the starting position (after the label)
    startIndex = labelIndex + "Description:".length;
  }

  // Skip any whitespace or newlines after startIndex
  while (startIndex < body.length && [' ', '\r', '\n'].includes(body[startIndex])) {
    startIndex++;
  }

  // Find the next newline after the actual content
  const newlineIndex = body.indexOf('\n', startIndex);

  if (newlineIndex === -1) {
    // If no newline found assume entire body is the description
    description = body.substring(startIndex).trim();
  } else {
    // Return text from label to newline
    description = body.substring(startIndex, newlineIndex).trim();
  }

  return description;
}

async function determineMissingInfo(description, links, body) {
  const prompt = `
Our PR expects a short description, and if they are required,
a list of feature flags(codehs specific), a list of loom links(demo videos),
and a list of live urls(links to the live site), and list of image urls(screenshots).
Given the description, links, determine if anything needs to be added to the body to make it more complete.

Rules:
- The feature flags are optional
- The loom links and image urls serve the same purpose, and are not needed for things that do not affect the frontend
- The live urls are not needed for things that do not affect the frontend
- The description is required, and should be a short description of the PR

Examples of incorrect info:
- The description is too short
- The description is not the correct selection because of the way the body is formatted
- The PR seems to add or edit a page and there is no image url or loom link
- The PR seems to add or edit a page and there is no live url, or the live url is just the base site url

Return JUST a short description of the PR that is missing or incorrect if there is any and why it is needed.
Otherwise return "No missing or incorrect info".

Description: ${description}
Links: ${JSON.stringify(links)}
Body: ${body}
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 150,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    return "Unable to determine missing info";
  }
}

function getOwlcastPRInfo(context) {
  const body = context.payload['pull_request']['body'];
  const number = context.payload['pull_request']['number'];
  let title = context.payload['pull_request']['title'];

  // Remove the percent status from the title
  const titlePercent = title.indexOf("[");

  if (titlePercent !== -1) {
      title = title.substring(0, titlePercent).trim();
  }

  const formattedTitle = `#${number} ${title}`;

  // Find the label in the text
  const labelIndex = body.indexOf("Description:");
  const description = body.substring(labelIndex + "Description:".length).trim();
  const links = parsePrLinks(body);


 const prInfo = `
# What Owlcast Scraped

## ${formattedTitle}
Description: ${description}

Feature Flags: 
${links.feature_flags.map(link => `- ${link}`).join("\n")}

Loom Links:
${links.loom_links.map(link => `- ${link}`).join("\n")}

Live URLs: 
${links.live_urls.map(link => `- ${link}`).join("\n")}

Image URLs: 
${links.image_urls.map(link => `- ${link}`).join("\n")}

Missing Info:
${links.missing_info.map(info => `- ${info}`).join("\n")}
    `

  return prInfo;
}