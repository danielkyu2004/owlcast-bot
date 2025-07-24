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

  try {
    const response = await fetch('http://localhost:9000/api/get-specific-pr-data/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    const featureFlags = data.links.feature_flags || [];
    const loomLinks = data.links.loom_links || [];
    const liveUrls = data.links.live_urls || [];
    const imageUrls = data.links.image_urls || [];
    const description = data.description || "";
    const missingInfo = data.missing_info || [];

    const prInfo = `
# What Owlcast Scraped

## ${formattedTitle}
Description: ${description}

Feature Flags: 
${featureFlags.map(link => `- ${link}`).join("\n")}

Loom Links:
${loomLinks.map(link => `- ${link}`).join("\n")}

Live URLs: 
${liveUrls.map(link => `- ${link}`).join("\n")}

Image URLs: 
${imageUrls.map(link => `- ${link}`).join("\n")}

Missing Info:
${missingInfo}
    `

    return prInfo;
  } catch (error) {
    console.error('Error calling API:', error);
    // Fallback to original function if API fails
    return getOwlcastPRInfo(context);
  }
}

function getOwlcastPRInfo(context) {
  const body = context.payload['pull_request']['body'];
  const number = context.payload['pull_request']['number'];
  let title = context.payload['pull_request']['title'];
  const username = context.payload['pull_request']['user']['login'];
  const github_url = context.payload['pull_request']['html_url'];

  // Remove the percent status from the title
  const titlePercent = title.indexOf("[");

  if (titlePercent !== -1) {
      title = title.substring(0, titlePercent).trim();
  }

  const formattedTitle = `#${number} ${title}`;

  // Find the label in the text
  const labelIndex = body.indexOf("Description:");
  let description = "";
  let startIndex;

  if (labelIndex === -1) {
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

  if (description.trim() === "") {
      // if there is no description, use the title
      description = title;
  }

  const { featureFlags, loomLinks, liveUrls, imageUrls } = parseUrlTypes(body);

  const prInfo = `
# What Owlcast Scraped

## ${formattedTitle}
Description: ${description}

Feature Flags: 
  --
  ${featureFlags.join("\n")}

Loom Links:
  --
  ${loomLinks.join("\n")}

Live URLs: 
  --
  ${liveUrls.join("\n")}

Image URLs: 
  --
  ${imageUrls.join("\n")}
  `

  return prInfo;
}

function parseUrlTypes(body) {
  // Find the feature flags in the body
  // Returns the links to the feature flags, no names yet
  // only works for codehs
  const featureFlagRegex = /(?:https?:\/\/)?(?:www\.)?codehs\.com\/internal\/feature_flag\/\d+/g;
  // ensure all links have https:// before adding to the set
  let featureFlags = [...new Set((body.match(featureFlagRegex) || []).map(link => {
    if (!link.startsWith('http')) return 'https://' + link;
    return link.replace(/^http:/, 'https:');
  }))];
  // Add bullet points to the loom links
  featureFlags = featureFlags.map(link => `- ${link}`);

  // Find the loom links in the body
  const loomRegex = /(?:https?:\/\/)?(?:www\.)?loom\.com\/share\/[a-zA-Z0-9]+/g;
  let loomLinks = [...new Set((body.match(loomRegex) || []).map(link => {
    if (!link.startsWith('http')) return 'https://' + link;
    return link.replace(/^http:/, 'https:');
  }))];
  // Add bullet points to the loom links
  loomLinks = loomLinks.map(link => `- ${link}`);

  // Trust that live urls are after the Live URLs: label
  const liveUrlsIndex = body.indexOf("Live URLs:");
  let liveUrls = [];

  if (liveUrlsIndex !== -1) {
      const newlineIndex = body.indexOf('\n', liveUrlsIndex);
      const liveUrlsText = body.substring(newlineIndex).trim();
      // Remove hyphens and extract only the URLs
      const liveUrlMatches = liveUrlsText.match(/https:\/\/[^\s]+/g) || [];
      liveUrls = [...new Set(liveUrlMatches.map(link => {
        if (!link.startsWith('http')) return 'https://' + link;
        return link.replace(/^http:/, 'https:');
      }))];
      liveUrls = liveUrls.map(link => `- ${link}`);
    }

  // Find image URLs in src attributes
  const imageUrlRegex = /https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9-]+/g;
  let imageUrls = [...new Set((body.match(imageUrlRegex) || []).map(link => {
    if (!link.startsWith('http')) return 'https://' + link;
    return link.replace(/^http:/, 'https:');
  }))];
  // Add bullet points to the image urls
  imageUrls = imageUrls.map(link => `- ${link}`);

  return {
      featureFlags,
      loomLinks,
      liveUrls,
      imageUrls
  };
}
