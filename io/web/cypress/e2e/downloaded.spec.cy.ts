describe("template spec", () => {
  it("passes", () => {
    cy.clearAllLocalStorage();
    cy.wait(1000);
    cy.visit("http://localhost:3000");
    cy.get("[data-cyid='loginMenu']").click();
    cy.get("[data-cyid='email']").click().type("wildananugrah@gmail.com");
    cy.get("[data-cyid='password']").click().type("p@ssw0rd");
    cy.wait(1000).get("[data-cyid='loginButton']").click();
    cy.wait(1000).get("[data-cyid='profileMe']").click();
    cy.wait(500).get("[data-cyid='downloadedProductMenu']").click();
  });
});
